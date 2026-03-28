---
title: "ATL深度解析（6）事件循环融合 — 让 Android Handler 和 GTK MainLoop 共舞"
description: "分析 ATL 如何将 Android 的 Looper/Handler 事件模型与 GTK 的 GMainLoop 融合，实现统一的事件驱动架构"
pubDatetime: 2025-12-15T00:00:00Z
modDatetime: 2025-12-15T00:00:00Z
author: "xuwakao"
slug: "atl-event-loop-fusion"
tags:
  - android
  - linux
  - atl
  - event-loop
  - gtk4
featured: false
---
# 事件循环融合 — 让 Android Handler 和 GTK MainLoop 共舞

> 本文是 Android Translation Layer (ATL) 源码分析系列的第六篇（完结篇）。前五篇我们分别剖析了整体架构、Java Framework 重新实现、NDK API 重新实现、ART 独立化，以及 Bionic 兼容层。本篇将深入 ATL 中技术上最精妙的一环：如何将 Android 的 Handler/Looper 消息循环与 GLib/GTK 的 MainLoop 事件循环融合在同一条主线程上。

---

## 1. 概念铺垫：两个事件循环的碰撞

要理解 ATL 的事件循环融合方案，我们首先需要分别理解 Android 和 GLib 各自的事件模型。

### Android 的事件模型

Android 的 UI 线程驱动机制由四个核心类组成：**Looper**、**MessageQueue**、**Handler** 和 **Message**。

**Looper** 是绑定在线程上的事件循环。每个线程最多只能有一个 Looper，通过 `ThreadLocal` 存储。在 AOSP 中，Looper 底层基于 Linux 的 `epoll` 机制实现阻塞等待。主线程的 Looper 由 `ActivityThread.main()` 调用 `Looper.prepareMainLooper()` 创建，随后调用 `Looper.loop()` 进入无限循环，驱动整个应用的 UI 更新、生命周期回调和所有异步任务。

**MessageQueue** 是一个按投递时间（`when` 字段）排序的单链表。它持有一个指向原生层的指针 `mPtr`，通过 JNI 调用 `nativePollOnce` 实现阻塞等待，调用 `nativeWake` 实现唤醒。在 AOSP 中，`nativePollOnce` 最终调用 C++ 层 `Looper::pollOnce`，阻塞在 `epoll_wait` 上。

**Handler** 是消息的发送者和接收者。每个 Handler 绑定一个 Looper（及其 MessageQueue）。调用 `handler.post(runnable)` 或 `handler.sendMessage(msg)` 会将消息入队到对应的 MessageQueue。当消息被取出时，Looper 会回调 Handler 的 `dispatchMessage` 方法。

**Message** 是消息的载体，携带 `what`（整型标识）、`obj`（任意对象）、`callback`（Runnable）、`target`（目标 Handler）和 `when`（投递时间戳）等字段。Message 还通过 `next` 指针形成链表结构，既用于 MessageQueue 的排序链表，也用于对象池的回收链表。

### GLib 的事件模型

GLib 的事件系统同样由三个核心概念组成：**GMainLoop**、**GMainContext** 和 **GSource**。

**GMainLoop** 是事件循环的运行器，它反复迭代一个 GMainContext。在 GTK4 中，`g_application_run()` 内部创建并运行主事件循环。

**GMainContext** 是事件源的管理器。它持有一组 GSource，在每次迭代中依次执行 prepare、query、poll、check、dispatch 五个阶段。默认 GMainContext 管理着 GTK widget 事件、D-Bus 信号、文件描述符监控、定时器等各种事件源。

**GSource** 是抽象的事件源。开发者通过实现 `GSourceFuncs` 结构体中的 `prepare`、`check`、`dispatch` 回调函数来定义自定义事件源。GSource 还有一个关键属性：`ready_time` -- 当设置为某个时间戳时，GLib 会在该时间到达后将此 source 标记为就绪并调度其 dispatch 回调。设置为 0 表示立即就绪，设置为 -1 表示不主动就绪。

### 冲突所在

问题的核心在于：**两个事件循环都想独占主线程**。

Android 的 `Looper.loop()` 是一个无限循环：

```java
// Looper.java:124
for (;;) {
    Message msg = queue.next(); // might block
    if (msg == null) { return; }
    msg.target.dispatchMessage(msg);
    msg.recycle();
}
```

GTK 的 `g_application_run()` 同样是一个无限循环，在内部反复调用 `g_main_context_iteration()` 来 poll 和 dispatch 各种事件源。

它们不可能同时阻塞在同一条线程上。如果让 `Looper.loop()` 跑起来，GTK 的 widget 事件、绘制回调、窗口管理就全部停摆；反之亦然。这就是 ATL 必须解决的核心矛盾。

---

## 2. 融合架构：GSource 嫁接方案

ATL 采用了一个优雅的解决方案：**将 Android 的 MessageQueue 包装成一个 GSource，嫁接到 GLib 的主事件循环中**。

核心设计原则：

- **主线程**：GLib 控制事件循环，Android 的消息调度作为 GSource 被 GLib 周期性地触发
- **工作线程**：Android Looper 完全控制，不涉及 GSource，行为与 AOSP 完全一致

这个方案的实现集中在一个 115 行的 C 文件中：`src/api-impl-jni/android_os_MessageQueue.c`。

核心数据结构是 `native_message_queue`：

```c
// src/api-impl-jni/android_os_MessageQueue.c:13-17
struct native_message_queue {
    ALooper *looper;
    bool in_callback;
    bool is_main_thread;
};
```

每个 MessageQueue 在 Java 层创建时，都会通过 `nativeInit` 在原生层分配一个 `native_message_queue`。其中 `is_main_thread` 标志位是整个融合方案的分支判断依据 -- 主线程走 GSource 路径，工作线程走传统 ALooper 路径。

---

## 3. 初始化流程

### prepare_main_looper：创建 GSource 桥接

应用启动时，`main.c` 的 `open` 回调在完成 JVM 创建和 GTK 窗口初始化之后，调用 `prepare_main_looper`：

```c
// src/api-impl-jni/android_os_MessageQueue.c:41-54
void prepare_main_looper(JNIEnv *env)
{
    main_thread_id = g_thread_self();

    (*env)->CallStaticVoidMethod(env, handle_cache.looper.class,
                                 handle_cache.looper.prepareMainLooper);
    if ((*env)->ExceptionCheck(env))
        (*env)->ExceptionDescribe(env);
    source = g_source_new(&source_funcs, sizeof(GSource));
    JavaVM *jvm;
    (*env)->GetJavaVM(env, &jvm);
    g_source_set_callback(source, NULL, jvm, NULL);
    g_source_set_ready_time(source, 0);
    g_source_attach(source, NULL);
}
```

这个函数完成了四件关键事情：

1. **记录主线程标识**：`main_thread_id = g_thread_self()`，后续所有 MessageQueue 初始化时都通过比较 `g_thread_self() == main_thread_id` 来判断自己是否在主线程上。

2. **调用 Java 层 `Looper.prepareMainLooper()`**：在当前线程上创建 Looper 和 MessageQueue，设置为主 Looper。

3. **创建 GSource**：`source_funcs` 只定义了 `dispatch` 回调，没有 `prepare` 和 `check`。这意味着这个 GSource 完全靠 `ready_time` 来触发调度。

4. **设置 `ready_time` 为 0 并附加到默认 GMainContext**：`ready_time = 0` 意味着第一次 GLib 迭代就会立即调度这个 source，从而触发首次 Android 消息处理。

### nativeInit：每个 MessageQueue 的原生初始化

```c
// src/api-impl-jni/android_os_MessageQueue.c:56-65
JNIEXPORT jlong JNICALL Java_android_os_MessageQueue_nativeInit(
    JNIEnv *env, jclass this)
{
    struct native_message_queue *message_queue =
        malloc(sizeof(struct native_message_queue));
    message_queue->in_callback = false;
    message_queue->looper = ALooper_prepare(0);
    message_queue->is_main_thread =
        g_thread_self() == main_thread_id;
    return _INTPTR(message_queue);
}
```

`ALooper_prepare(0)` 为当前线程创建（或获取）一个 ALooper 实例。对于主线程，这个 ALooper 实际上不会被用于阻塞等待，但仍然需要创建以满足 API 兼容性。`is_main_thread` 的判定结果将决定后续 `nativePollOnce` 和 `nativeWake` 的行为分支。

### 调用时序

在 `main.c` 中，`prepare_main_looper` 的调用位于 GTK 窗口创建之后、Application 构造之前：

```c
// src/main-executable/main.c:466
prepare_main_looper(env);
```

此时 GLib 的主循环尚未开始迭代（仍在 `open` 回调内部），但 GSource 已经被附加。当 `open` 回调返回后，GTK 的 `g_application_run` 开始驱动主循环，第一次迭代就会发现 `ready_time = 0`，立即调度 Android 消息处理。

---

## 4. 主线程消息调度：完整流程

这是本文最核心的部分。我们将完整追踪一条消息从 `handler.post(runnable)` 到 `runnable.run()` 的全过程。

### 第一步：handler.post(runnable)

```java
// src/api-impl/android/os/Handler.java:321-323
public final boolean post(Runnable r) {
    return sendMessageDelayed(getPostMessage(r), 0);
}
```

`getPostMessage` 从对象池获取一个 Message，将 Runnable 设置为其 `callback` 字段。`sendMessageDelayed` 计算绝对时间后调用 `sendMessageAtTime`，最终到达 `enqueueMessage`：

```java
// src/api-impl/android/os/Handler.java:608-614
private boolean enqueueMessage(MessageQueue queue,
                               Message msg, long uptimeMillis) {
    msg.target = this;
    if (mAsynchronous) {
        msg.setAsynchronous(true);
    }
    return queue.enqueueMessage(msg, uptimeMillis);
}
```

关键点：`msg.target = this` -- 这将消息与发送它的 Handler 绑定，后续 dispatch 时会回调到同一个 Handler。

### 第二步：MessageQueue.enqueueMessage()

```java
// src/api-impl/android/os/MessageQueue.java:311-361（简化）
boolean enqueueMessage(Message msg, long when) {
    synchronized (this) {
        msg.when = when;
        Message p = mMessages;
        boolean needWake;
        if (p == null || when == 0 || when < p.when) {
            // 新消息成为链表头
            msg.next = p;
            mMessages = msg;
            needWake = mBlocked;
        } else {
            // 插入到链表中间，保持按 when 排序
            // ...
        }
        if (needWake) {
            nativeWake(mPtr);
        }
    }
    return true;
}
```

消息按 `when` 字段插入到排序链表中。如果队列正在阻塞状态（`mBlocked = true`）且新消息成为链表头，则需要唤醒。

### 第三步：nativeWake() -- 主线程路径

```c
// src/api-impl-jni/android_os_MessageQueue.c:98-108
JNIEXPORT void JNICALL Java_android_os_MessageQueue_nativeWake(
    JNIEnv *env, jclass this, jlong ptr)
{
    struct native_message_queue *message_queue = _PTR(ptr);

    if (message_queue->is_main_thread) {
        g_source_set_ready_time(source, 0); // immediately
        return;
    }

    ALooper_wake(message_queue->looper);
}
```

对于主线程，唤醒操作不是向 eventfd 写入数据，而是将 GSource 的 `ready_time` 设置为 0。这告诉 GLib："下一次迭代请立即调度我的 dispatch 回调"。

### 第四步：GLib 事件循环迭代

GLib 在其主循环的每次迭代中，检查所有已附加的 GSource。当发现我们的 source 的 `ready_time <= 当前时间` 时，调用其 dispatch 函数：

```c
// src/api-impl-jni/android_os_MessageQueue.c:24-35
static gboolean dispatch_func(GSource *source,
    GSourceFunc callback, gpointer user_data)
{
    JavaVM *jvm = user_data;
    JNIEnv *env;
    (*jvm)->GetEnv(jvm, (void **)&env, JNI_VERSION_1_6);
    g_source_set_ready_time(source, -1); // 清除超时
    (*env)->CallStaticVoidMethod(env, handle_cache.looper.class,
                                 handle_cache.looper.loop);
    if ((*env)->ExceptionCheck(env))
        (*env)->ExceptionDescribe(env);
    return G_SOURCE_CONTINUE;
}
```

注意第一行操作：`g_source_set_ready_time(source, -1)` -- 立即清除 ready_time，避免下次迭代无条件再次触发。然后调用 Java 层的 `Looper.loop()`。

### 第五步：Looper.loop()

```java
// src/api-impl/android/os/Looper.java:112-152
public static void loop() {
    final Looper me = myLooper();
    final MessageQueue queue = me.mQueue;
    for (;;) {
        Message msg = queue.next(); // might block
        if (msg == null) {
            return;  // <-- 关键：主线程上 null 表示"归还控制权给 GLib"
        }
        msg.target.dispatchMessage(msg);
        msg.recycle();
    }
}
```

ATL 对 `Looper.loop()` 的代码与 AOSP 几乎完全一致。但语义上有一个微妙的变化：在 AOSP 中，`msg == null` 仅在 MessageQueue 退出（quitting）时发生，意味着 Looper 永久终止。在 ATL 的主线程上，`null` 还可能表示"当前没有就绪消息，请把控制权还给 GLib"。

### 第六步：MessageQueue.next()

```java
// src/api-impl/android/os/MessageQueue.java:127-139（关键部分）
Message next() {
    int nextPollTimeoutMillis = 0;
    for (;;) {
        if (nativePollOnce(mPtr, nextPollTimeoutMillis)) {
            return null; // 主线程由 GLib 管理，返回而非阻塞
        }
        // ... 取出消息或计算下次超时 ...
    }
}
```

这是 ATL 对 AOSP 代码的唯一修改点。原版 `nativePollOnce` 返回 `void`，ATL 改为返回 `boolean`。当返回 `true` 时，`next()` 立即返回 `null`，最终导致 `Looper.loop()` 退出。

### 第七步：nativePollOnce() -- 核心分支逻辑

```c
// src/api-impl-jni/android_os_MessageQueue.c:74-96
JNIEXPORT jboolean JNICALL Java_android_os_MessageQueue_nativePollOnce(
    JNIEnv *env, jclass this, jlong ptr, jint timeout_millis)
{
    struct native_message_queue *message_queue = _PTR(ptr);

    if (message_queue->is_main_thread) {
        if (timeout_millis) {
            if (timeout_millis != -1)
                g_source_set_ready_time(source,
                    g_source_get_time(source) + timeout_millis * 1000L);
            return true;
        } else {
            return false;
        }
    }

    // 工作线程路径
    message_queue->in_callback = true;
    ALooper_pollOnce(timeout_millis, NULL, NULL, NULL);
    message_queue->in_callback = false;
    return false;
}
```

**这是整个融合方案中最关键的 20 行代码**。对于主线程，`timeout_millis` 的值决定了控制流的走向：

| timeout_millis | 含义 | 行为 | 返回值 |
|---|---|---|---|
| `0` | 有就绪消息待处理 | 继续在 Java 层取消息 | `false` |
| `> 0` | 最近的消息要等 N 毫秒 | 设置 GSource ready_time 为未来时间点，归还控制权 | `true` |
| `-1` | 队列为空，无消息 | 不设置 ready_time（等待 nativeWake 触发），归还控制权 | `true` |

返回 `false` 意味着 Java 层的 `next()` 继续执行，取出消息并分发。返回 `true` 意味着 Java 层的 `next()` 返回 `null`，`Looper.loop()` 退出，`dispatch_func` 返回，控制权回到 GLib。

注意单位转换：`timeout_millis * 1000L` -- Android 使用毫秒，GLib 的 `g_source_set_ready_time` 使用微秒。

### 第八步：消息分发

回到 `Looper.loop()` 中，当 `queue.next()` 返回一个非空消息时：

```java
// src/api-impl/android/os/Handler.java:92-103
public void dispatchMessage(Message msg) {
    if (msg.callback != null) {
        handleCallback(msg);  // 执行 Runnable
    } else {
        if (mCallback != null) {
            if (mCallback.handleMessage(msg)) {
                return;
            }
        }
        handleMessage(msg);  // 子类重写的方法
    }
}
```

分发优先级为：
1. `msg.callback` -- 如果消息携带 Runnable（来自 `handler.post()`），直接执行
2. `mCallback` -- Handler 构造时传入的 Callback 接口
3. `handleMessage()` -- Handler 子类重写的方法

分发完成后，消息被回收（`msg.recycle()`），循环继续取下一条消息。当所有就绪消息处理完毕，`nativePollOnce` 返回 `true`，控制权归还给 GLib。

---

## 5. 工作线程路径

工作线程的行为与 AOSP 完全一致，不涉及任何 GSource 逻辑。

### HandlerThread 的启动

```java
// src/api-impl/android/os/HandlerThread.java:52-63
public void run() {
    mTid = Process.myTid();
    Looper.prepare();
    synchronized (this) {
        mLooper = Looper.myLooper();
        notifyAll();
    }
    Process.setThreadPriority(mPriority);
    onLooperPrepared();
    Looper.loop();  // 永久阻塞，直到 quit
    mTid = -1;
}
```

`Looper.prepare()` 会创建 MessageQueue，触发 `nativeInit`。由于此时 `g_thread_self() != main_thread_id`，所以 `is_main_thread = false`。随后的 `Looper.loop()` 是一个真正的无限循环。

### nativePollOnce -- 工作线程路径

```c
// src/api-impl-jni/android_os_MessageQueue.c:88-95
// 工作线程路径（is_main_thread == false 时执行）
message_queue->in_callback = true;
ALooper_pollOnce(timeout_millis, NULL, NULL, NULL);
message_queue->in_callback = false;
return false;
```

`ALooper_pollOnce` 是 Android NDK 提供的标准 API，在 ATL 的 libandroid 中实现。它会阻塞当前线程直到有事件到达或超时。返回 `false` 意味着 Java 层继续循环，不会退出 `Looper.loop()`。

### nativeWake -- 工作线程路径

```c
// src/api-impl-jni/android_os_MessageQueue.c:107
ALooper_wake(message_queue->looper);
```

对于工作线程，唤醒操作调用 `ALooper_wake`，其底层实现通常是向 eventfd 写入一个字节，使得阻塞在 `ALooper_pollOnce`（即 `epoll_wait`）上的线程立即返回。

---

## 6. 超时与协作式调度

### 延时消息的处理

当一条延时消息被投递（例如 `handler.postDelayed(runnable, 500)`），消息入队后 `MessageQueue.next()` 发现该消息的 `when` 在未来，于是计算出 `nextPollTimeoutMillis`（比如 500）。随后 `nativePollOnce` 被调用：

```c
if (timeout_millis != -1)
    g_source_set_ready_time(source,
        g_source_get_time(source) + timeout_millis * 1000L);
return true;
```

这里 `timeout_millis * 1000L` 将毫秒转为微秒。GLib 记住了这个未来时间点。在此期间，主线程并没有闲置 -- GLib 继续处理其他事件源。

### 协作式交错调度

这是 GSource 嫁接方案最大的优势：Android 消息和 GTK 事件在同一条线程上协作式交错执行。下面的 ASCII 时间线展示了一个典型的主线程调度周期：

```
时间轴 ──────────────────────────────────────────────────────────>

GLib 迭代 #1:
  ├─ [GSource ready_time=0, dispatch]
  │   ├─ dispatch_func() 调用 Looper.loop()
  │   │   ├─ nativePollOnce(0) -> false   (有就绪消息)
  │   │   ├─ 取出 Message A, dispatchMessage()
  │   │   ├─ nativePollOnce(0) -> false   (还有就绪消息)
  │   │   ├─ 取出 Message B, dispatchMessage()
  │   │   ├─ nativePollOnce(300) -> true  (下条消息要等 300ms)
  │   │   │   └─ g_source_set_ready_time(now + 300000us)
  │   │   └─ next() 返回 null, loop() 返回
  │   └─ dispatch_func 返回 G_SOURCE_CONTINUE
  │
  ├─ [GTK widget 事件: 按钮点击回调]
  ├─ [D-Bus 信号处理]
  └─ [poll: 等待下一个事件，最多 300ms]

GLib 迭代 #2:  (300ms 后)
  ├─ [GSource ready_time 到达, dispatch]
  │   ├─ dispatch_func() 调用 Looper.loop()
  │   │   ├─ nativePollOnce(0) -> false
  │   │   ├─ 取出 Message C, dispatchMessage()
  │   │   ├─ nativePollOnce(-1) -> true   (队列空)
  │   │   │   └─ 不设置 ready_time (等待 nativeWake)
  │   │   └─ next() 返回 null, loop() 返回
  │   └─ dispatch_func 返回 G_SOURCE_CONTINUE
  │
  ├─ [GTK 绘制回调: draw signal]
  └─ [poll: 无限等待，直到新事件]

  ... 某工作线程投递消息，调用 nativeWake ...
       └─ g_source_set_ready_time(source, 0)

GLib 迭代 #3:  (被唤醒)
  ├─ [GSource ready_time=0, dispatch]
  │   └─ ...
```

可以看到，在 Android 消息等待的间隙，GTK 的 widget 事件、绘制回调和其他系统事件得以正常处理。这是真正的协作式多路复用：两套框架共享一条线程，互不阻塞。

---

## 7. IdleHandler 和 Barrier 消息

ATL 的 MessageQueue 忠实地从 AOSP 移植了 IdleHandler 和同步屏障（Sync Barrier）机制。

### IdleHandler

当 `MessageQueue.next()` 发现没有就绪消息时（队列为空或最早消息在未来），会执行注册的 IdleHandler：

```java
// src/api-impl/android/os/MessageQueue.java:185-218（简化）
if (pendingIdleHandlerCount < 0
    && (mMessages == null || now < mMessages.when)) {
    pendingIdleHandlerCount = mIdleHandlers.size();
}
// ...
for (int i = 0; i < pendingIdleHandlerCount; i++) {
    final IdleHandler idler = mPendingIdleHandlers[i];
    boolean keep = idler.queueIdle();
    if (!keep) {
        mIdleHandlers.remove(idler);
    }
}
```

IdleHandler 的 `queueIdle()` 返回 `true` 表示保留，`false` 表示一次性使用后移除。IdleHandler 只在每次进入空闲状态的第一次迭代中执行（`pendingIdleHandlerCount` 随后被重置为 0），避免重复调用。

这一机制在 Android 中被广泛用于延迟初始化、GC 触发和性能监控。ATL 对其完整保留，确保依赖 IdleHandler 的库能正常工作。

### Barrier 消息（同步屏障）

Barrier 是一种特殊的消息，其 `target` 字段为 `null`。当 `MessageQueue.next()` 在链表头遇到 barrier 时，会跳过所有同步消息，只处理异步消息（`isAsynchronous() == true`）：

```java
// src/api-impl/android/os/MessageQueue.java:146-151
if (msg != null && msg.target == null) {
    // 被 barrier 阻塞，寻找下一条异步消息
    do {
        prevMsg = msg;
        msg = msg.next;
    } while (msg != null && !msg.isAsynchronous());
}
```

同步屏障在 Android 框架中用于 View 绘制流程：`Choreographer` 在请求 VSYNC 后发布屏障，阻塞普通消息，确保绘制回调（作为异步消息）优先执行。ATL 通过 `Looper.postSyncBarrier()` 和 `Looper.removeSyncBarrier()` 完整暴露了这一 API。

---

## 8. 对比：AOSP 的原生实现 vs ATL

为了清晰地理解 ATL 的融合方案，我们将其与 AOSP 的原始实现逐点对比：

| 维度 | AOSP | ATL 主线程 | ATL 工作线程 |
|---|---|---|---|
| nativePollOnce | C++ Looper::pollOnce，阻塞在 epoll_wait | 不阻塞，设置 GSource ready_time 后返回 | ALooper_pollOnce，阻塞等待 |
| nativeWake | 写入 eventfd | g_source_set_ready_time(0) | ALooper_wake |
| Looper.loop() | 永久运行，仅 quit 时退出 | 处理完当前批次后返回，被 GSource 反复重入 | 永久运行，与 AOSP 相同 |
| 主循环所有者 | Android (Looper) | GLib (GMainLoop) | Android (Looper) |
| nativePollOnce 返回类型 | void | boolean | boolean (但始终 false) |

**核心语义变化只有一处**：主线程上，事件循环的所有权从 Android 转移到了 GLib。`Looper.loop()` 不再是一个永久运行的无限循环，而是变成了一个"处理当前批次就绪消息后退出"的批处理函数。GSource 的 dispatch 回调反复调用它，形成了等价的效果。

这个变化对上层 Java 代码完全透明。Handler.post()、sendMessage()、postDelayed() 等所有 API 行为不变。消息的排序、超时、IdleHandler、Barrier 全部按照 AOSP 语义运作。唯一的区别在于"谁在驱动轮子转"-- 从 epoll_wait 变成了 GLib 的 poll。

对于工作线程，行为与 AOSP 完全一致。`nativePollOnce` 会真正阻塞在 `ALooper_pollOnce` 中，`nativeWake` 通过 `ALooper_wake` 唤醒。这意味着使用 HandlerThread 的库代码无需任何修改就能正常运行。

---

## 9. Message 对象池

Android 的 Message 类实现了一个经典的对象池模式，用于减少频繁的内存分配和 GC 压力。ATL 完整保留了这一实现。

### 池结构

```java
// src/api-impl/android/os/Message.java:100-104
private static final Object sPoolSync = new Object();
private static Message sPool;
private static int sPoolSize = 0;
private static final int MAX_POOL_SIZE = 50;
```

`sPool` 是一个静态链表头指针，通过 Message 的 `next` 字段形成单链表。池最大容量为 50 个对象。

### 获取：Message.obtain()

```java
// src/api-impl/android/os/Message.java:110-121
public static Message obtain() {
    synchronized (sPoolSync) {
        if (sPool != null) {
            Message m = sPool;
            sPool = m.next;
            m.next = null;
            sPoolSize--;
            return m;
        }
    }
    return new Message();
}
```

优先从池中获取已回收的 Message 实例。池为空时才创建新对象。`synchronized (sPoolSync)` 保证线程安全，因为多个线程可能同时调用 `obtain()`。

### 回收：msg.recycle()

```java
// src/api-impl/android/os/Message.java:252-262
public void recycle() {
    clearForRecycle();
    synchronized (sPoolSync) {
        if (sPoolSize < MAX_POOL_SIZE) {
            next = sPool;
            sPool = this;
            sPoolSize++;
        }
    }
}
```

`clearForRecycle()` 将所有字段重置为零值（what=0, arg1=0, arg2=0, obj=null, target=null, callback=null, when=0, data=null, flags=0），然后将 Message 压入池链表头部。超过 50 个的实例直接丢弃，交给 GC 处理。

### Message 的完整字段清单

ATL 中的 Message 包含以下字段，与 AOSP 一致：

- `what` (int) -- 消息标识码
- `arg1`, `arg2` (int) -- 轻量整型参数
- `obj` (Object) -- 任意附加对象
- `replyTo` (Messenger) -- 回复目标
- `when` (long) -- 投递时间戳（毫秒）
- `target` (Handler) -- 目标 Handler
- `callback` (Runnable) -- 回调函数
- `next` (Message) -- 链表下一节点（队列/池共用）
- `data` (Bundle) -- 附加数据包
- `flags` (int) -- 标志位（FLAG_IN_USE, FLAG_ASYNCHRONOUS）

---

## 系列总结

至此，Android Translation Layer 源码分析系列的六篇文章全部完成。让我们回顾整个系列的脉络：

**第一篇**介绍了 ATL 的整体架构 -- 一个在 Linux 桌面上运行 Android 应用的翻译层，通过 JNI 桥接将 Android 的 Java API 映射到 GTK4 和 GLib 的原生实现。

**第二篇**剖析了 Java Framework 的重新实现，展示了 ATL 如何用 784 个 Java 文件和 82 个 C 文件重建 Activity 生命周期、View 体系、Canvas 绘制、系统服务等核心 API，将 Android UI 映射为 GTK4 Widget。

**第三篇**分析了 NDK API 的重新实现，揭示了 ATL 如何重写 libandroid.so，包括 ANativeWindow 的 Wayland/X11 适配、EGL 三缓冲渲染、Vulkan/OpenXR 透明转换等，让 native 游戏跑在 Linux 桌面上。

**第四篇**探讨了 ART 虚拟机的独立化，说明了 art_standalone 如何从 AOSP 中提取 ART 及其依赖，替换构建系统，并做出关键修改（非致命 JNI 查找、C API 新增等）使其在 Linux 上独立运行。

**第五篇**深入了 Bionic 兼容层，展示了 bionic_translation 如何通过 shim 动态链接器和 ABI 翻译函数，让 Bionic 编译的 .so 文件在 glibc/musl 环境中正确执行——从结构体布局转换到 TLS 槽位对齐。

**本篇（第六篇）** 深入分析了事件循环融合，这是 ATL 中最精妙的工程决策之一。通过仅仅修改 `nativePollOnce` 的返回值语义，并创建一个不到 40 行核心代码的 GSource 桥接层，ATL 实现了 Android Handler 消息系统与 GLib MainLoop 的无缝共存。主线程上，GLib 掌控事件循环，Android 消息作为其中一个事件源被周期性调度；工作线程上，行为与 AOSP 完全一致。

整个 ATL 项目展示了一种务实的工程哲学：不追求完美复刻 Android 的每一个细节，而是在关键的桥接点上做出最小且最精确的改动，让两个截然不同的 UI 框架在同一个进程中和谐共处。
