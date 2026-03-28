---
title: "ATL深度解析（2）Java Framework 重实现 — 用 GTK4 重写 Android API"
description: "深入分析 ATL 如何用 GTK4 重新实现 Android Java Framework API，包括 Activity、View、Window 等核心组件的映射策略"
pubDatetime: 2025-11-08T00:00:00Z
modDatetime: 2025-11-08T00:00:00Z
author: "xuwakao"
slug: "atl-java-framework-reimplementation"
tags:
  - android
  - linux
  - atl
  - gtk4
  - framework
featured: false
---

# Java Framework 重实现 — 用 GTK4 重写 Android API

> 这是 ATL（Android Translation Layer）系列技术分析的第 2 篇。上一篇介绍了整体架构，本篇将深入探讨 ATL 如何在没有 Android 系统基础设施的情况下，用 GTK4/GLib 重新实现 Android Java Framework 的核心 API。

---

## 1. 概念铺垫：Android Framework 是什么

在 AOSP（Android Open Source Project）中，`frameworks/base/` 目录包含了 Android 应用开发者最熟悉的那些 API 类：Activity、View、Context、Intent、Canvas、TextView 等等，合计数千个 Java 类。这些类构成了 Android 应用的运行时环境——开发者调用 `startActivity()`、`setContentView()`、`canvas.drawRect()` 这些方法时，背后都是这些 Framework 类在工作。

然而在 AOSP 中，这些类并不是自包含的。它们严重依赖若干系统级基础设施：

- **ActivityManagerService (AMS)**：通过 Binder IPC 驱动 Activity 的生命周期状态转换
- **WindowManagerService (WMS)**：管理窗口层级和显示
- **SurfaceFlinger**：负责将各窗口的渲染结果合成到屏幕上
- **SystemServer**：托管 AudioManager、SensorManager 等几十个系统服务
- **Binder IPC**：几乎所有跨进程通信都依赖它

ATL 的核心挑战在于：让 Android APK 中的 Java 字节码能够正常调用这些 API，但运行环境中没有上述任何一项基础设施。取而代之的是 Linux 桌面上的 GTK4、GLib、PipeWire 等组件。

---

## 2. ATL 的实现策略：三种文件来源

ATL 的 Java Framework 层位于 `src/api-impl/` 目录下，其中的文件按来源可分为三类：

**从 AOSP 复制并修改**：约 329 个文件保留了 AOSP 的版权头。这些文件通常是数据结构类（如 `SparseArray`、`ArrayMap`）或纯逻辑类（如 `TextUtils`、`Color`），它们在 AOSP 中本身就不依赖系统服务，因此可以较少修改地复用。

**全新编写**：约 455 个文件没有 AOSP 版权头，是 ATL 为了对接 GTK4 而从头编写的。这些文件涵盖了 Activity、View、Canvas、各种 Widget 以及系统服务等核心类。

**自动生成**：`R.java` 和 `com/android/internal/R.java` 是由 `aapt` 工具根据 framework 资源自动生成的，合计约 147,606 行，定义了框架资源的 ID 常量。

在 JNI 侧，`src/api-impl-jni/` 目录下有 82 个 C 文件，负责将 Java 方法调用桥接到 GTK4/GLib 的原生 API。

总计大约 784 个 Java 文件加 82 个 C 文件，共同组成了 ATL 的 Framework 重实现。

### 编译流程

编译通过 Meson 构建系统组织，核心步骤如下：

```
Java 源码 → javac → hax.jar → dx → api-impl.jar (DEX 格式)
```

构建脚本（`src/api-impl/meson.build:786-813`）中定义了编译参数：

```python
# src/api-impl/meson.build
java_args = [
    '-bootclasspath', bootclasspath,
    '-source', '1.8', '-target', '1.8',
    '-encoding', 'UTF-8',
    '-Xlint:-deprecation',
    '-h', join_paths(dir_base, 'src/api-impl-jni/generated_headers')
]
```

编译时同时生成 JNI 头文件（`-h` 参数），供 C 端实现使用。如果系统安装了 `ant`，则使用 ant 构建 hax.jar；否则回退到 Meson 内置的 `jar()` 函数。

---

## 3. Activity 生命周期桥接

### AOSP 怎么做

在标准 Android 中，Activity 生命周期由 AMS 通过 Binder IPC 远程驱动。当用户点击应用图标时，Launcher 通过 AMS 发起 `startActivity`，AMS 分配任务栈、管理进程，然后通过 `ApplicationThread` 这个 Binder 代理回调到应用进程，依次触发 `onCreate` -> `onStart` -> `onResume` 等生命周期方法。整个过程涉及至少两次跨进程 IPC 调用。

### ATL 怎么做

ATL 中没有 AMS，也没有 Binder IPC。取而代之的是一个用 GLib 的 `GList` 实现的 Activity 回退栈，加上 JNI 回调构成的状态机。

核心数据结构定义在 C 侧（`src/api-impl-jni/app/android_app_Activity.c`）：

```c
// src/api-impl-jni/app/android_app_Activity.c
static GList *activity_backlog = NULL;   // Activity 回退栈
static jobject activity_current = NULL;  // 当前前台 Activity
```

当启动一个新 Activity 时，`activity_start()` 函数直接在当前进程内依次调用生命周期方法：

```c
// src/api-impl-jni/app/android_app_Activity.c
void activity_start(JNIEnv *env, jobject activity_object)
{
    if (activity_current)
        activity_unfocus(env, activity_current);
    activity_current = NULL;
    (*env)->CallVoidMethod(env, activity_object,
                           handle_cache.activity.onCreate, NULL);
    // ... 异常检查省略 ...
    (*env)->CallVoidMethod(env, activity_object,
                           handle_cache.activity.onPostCreate, NULL);
    activity_backlog = g_list_prepend(activity_backlog,
                                      _REF(activity_object));
    activity_update_current(env);
}
```

`activity_focus()` 负责将一个 Activity 推到前台：

```c
// src/api-impl-jni/app/android_app_Activity.c
static void activity_focus(JNIEnv *env, jobject activity)
{
    if (_GET_BOOL_FIELD(activity, "finishing"))
        return;
    (*env)->CallVoidMethod(env, activity,
                           handle_cache.activity.onStart);
    // ... finishing 检查 ...
    (*env)->CallVoidMethod(env, activity,
                           handle_cache.activity.onResume);
    (*env)->CallVoidMethod(env, activity,
                           handle_cache.activity.onPostResume);
    (*env)->CallVoidMethod(env, activity,
                           handle_cache.activity.onWindowFocusChanged, true);
}
```

Java 侧（`src/api-impl/android/app/Activity.java`）的 `internalCreateActivity()` 负责通过反射实例化 Activity 并配置好上下文：

```java
// src/api-impl/android/app/Activity.java
public static Activity internalCreateActivity(String className,
        long native_window, Intent intent)
        throws ReflectiveOperationException {
    Class<? extends Activity> cls =
        Class.forName(className).asSubclass(Activity.class);
    Activity activity = cls.getConstructor().newInstance();
    activity.intent = intent;
    activity.attachBaseContext(
        new ContextImpl(r, pkg.applicationInfo, theme_res));
    activity.window = new Window(activity, activity);
    activity.window.set_native_window(native_window);
    return activity;
}
```

### 生命周期状态机

完整的状态转换可以用下面的流程概括：

```
activity_start():
  旧 Activity: onPause → onStop → onWindowFocusChanged(false)
  新 Activity: onCreate → onPostCreate → 压入 backlog 栈首
               → onStart → onResume → onPostResume
               → onWindowFocusChanged(true)

nativeFinish():
  从 backlog 移除 → onPause → onStop → onWindowFocusChanged(false)
  → onDestroy → 如果栈空则关闭 GTK 窗口
```

### 为什么这样做

ATL 运行的所有 Activity 实际上共享同一个 GTK 窗口和同一个操作系统进程。不需要 IPC 就能完成生命周期驱动，用一个简单的 GList 栈和直接的 JNI 方法调用就够了。这大幅简化了实现，同时保持了与 Android API 契约的兼容性。

---

## 4. View 体系：WrapperWidget 双层架构

### AOSP 怎么做

Android 的 View 体系遵循经典的 measure -> layout -> draw 三阶段管线。每个 View 接收父容器给出的 MeasureSpec（尺寸约束），测量自身大小，然后在 layout 阶段确定位置，最后在 draw 阶段通过 Canvas 绘制到 Surface 上。整个过程由 `ViewRootImpl` 驱动，最终通过 `SurfaceFlinger` 合成到屏幕。

### ATL 怎么做

ATL 使用一个自定义的 GTK Widget 类——`WrapperWidget`——作为每个 Android View 在 GTK 侧的代理。架构是双层的：

```
+--WrapperWidget (外层)---------------+
|  - 负责绘制(snapshot)和事件分发     |
|  - 持有 Java View 的弱引用 (jobj)   |
|  +--JavaWidget (内层, 如 GtkBox)--+ |
|  |  - 持有子 Widget               | |
|  |  - 使用 AndroidLayout 管理布局 | |
|  +--------------------------------+ |
+-------------------------------------+
```

`WrapperWidget` 是一个通过 GLib 类型系统注册的自定义 GTK Widget（`src/api-impl-jni/widgets/WrapperWidget.c`）：

```c
// src/api-impl-jni/widgets/WrapperWidget.c
G_DEFINE_TYPE(WrapperWidget, wrapper_widget, GTK_TYPE_WIDGET)
```

核心的 `wrapper_widget_set_jobject()` 函数负责将 Java View 对象与 GTK Widget 关联，并根据 Java 类是否重写了特定方法来按需注册事件控制器：

```c
// src/api-impl-jni/widgets/WrapperWidget.c
void wrapper_widget_set_jobject(WrapperWidget *wrapper,
                                JNIEnv *env, jobject jobj)
{
    wrapper->jobj = _WEAK_REF(jobj);
    // 检测是否重写了 onDraw/draw/dispatchDraw 方法
    jmethodID draw_method = _METHOD(_CLASS(jobj), "draw",
        "(Landroid/graphics/Canvas;)V");
    jmethodID dispatch_draw_method = _METHOD(_CLASS(jobj),
        "dispatchDraw", "(Landroid/graphics/Canvas;)V");
    if (on_draw_method != handle_cache.view.onDraw
        || draw_method != handle_cache.view.draw
        || dispatch_draw_method != handle_cache.view.dispatchDraw) {
        wrapper->draw_method = draw_method;
        // 创建 GskCanvas 给 Java 侧使用
        wrapper->canvas = _REF((*env)->NewObject(env,
            canvas_class, canvas_constructor, 0));
    }
    // 检测是否重写了 onTouchEvent
    // 若是，注册 GtkEventControllerLegacy
    // 检测是否重写了 dispatchKeyEvent
    // 若是，注册 GtkEventControllerKey
    g_signal_connect(wrapper, "map", G_CALLBACK(map_cb),
        handle_cache.view.onAttachedToWindow);
    g_signal_connect(wrapper, "unmap", G_CALLBACK(unmap_cb),
        handle_cache.view.onDetachedFromWindow);
}
```

这个设计非常精巧：只有当 Java 子类实际重写了某个回调方法时，才会注册对应的 GTK 事件控制器。这避免了不必要的开销。

### 布局参数映射

Android 的布局参数需要映射到 GTK 的对应概念。核心映射逻辑在 `android_view_View.c` 的 `native_setLayoutParams` 中：

| Android LayoutParams | GTK4 等价物 |
|---|---|
| `width = MATCH_PARENT` | `hexpand = TRUE, halign = FILL` |
| `height = MATCH_PARENT` | `vexpand = TRUE, valign = FILL` |
| `wrap_content` | 默认（不设置 expand） |
| `gravity = CENTER` | `halign = CENTER, valign = CENTER, expand = TRUE` |
| `gravity = RIGHT` | `halign = END` |
| `gravity = TOP` | `valign = START` |
| `weight > 0` | `hexpand = TRUE, vexpand = TRUE` |

### 触摸事件管线

触摸事件从 GTK 事件系统流向 Java View 的完整路径：

```
GdkEvent (BUTTON_PRESS / TOUCH_BEGIN / MOTION_NOTIFY)
  → GtkEventControllerLegacy (on_pointer_event)
    → 坐标变换到 Widget 相对坐标
      → 构造 Java MotionEvent (JNI NewObject)
        → view_dispatch_motionevent()
          → View.dispatchTouchEvent() 或 View.onTouchEvent()
```

在 C 侧（`src/api-impl-jni/views/android_view_View.c`），`view_dispatch_motionevent()` 实现了完整的事件分发逻辑，包括对 `onInterceptTouchEvent` 的支持和事件取消机制：

```c
// src/api-impl-jni/views/android_view_View.c
bool view_dispatch_motionevent(JNIEnv *env, WrapperWidget *wrapper,
    GtkPropagationPhase phase, jobject motion_event,
    gpointer event, int action)
{
    if (wrapper->custom_dispatch_touch) {
        ret = (*env)->CallBooleanMethod(env, this,
            handle_cache.view.dispatchTouchEvent, motion_event);
    } else if (phase == GTK_PHASE_CAPTURE
               && !wrapper->intercepting_touch) {
        wrapper->intercepting_touch = (*env)->CallBooleanMethod(
            env, this,
            handle_cache.view.onInterceptTouchEvent, motion_event);
        // ...
    }
    // ...
}
```

---

## 5. Canvas 绘制：即时模式 -> 保留模式

### AOSP 怎么做

Android 的 `Canvas` API 是一个经典的即时模式（immediate-mode）绘图接口。开发者在 `onDraw(Canvas)` 中直接调用 `drawRect()`、`drawBitmap()`、`drawText()` 等方法，这些调用立即记录到底层的 Skia 绘图引擎中。

### ATL 怎么做

GTK4 的渲染模型完全不同——它使用保留模式（retained-mode）的 `GtkSnapshot`（也叫 `GskSnapshot`）。开发者不是发出绘图命令，而是构建一棵渲染节点树，GTK 的渲染器随后遍历这棵树来绘制。

ATL 通过 `android_atl_GskCanvas` 这个 JNI 桥梁将 Android Canvas 的即时模式调用翻译为 GTK4 的 Snapshot 操作。核心映射关系如下：

| Android Canvas 方法 | GTK4 Snapshot 操作 |
|---|---|
| `drawBitmap()` | `gtk_snapshot_append_texture()` |
| `drawRect()` | `gtk_snapshot_append_color()` |
| `drawPath()` (fill) | `gtk_snapshot_append_fill()` |
| `drawPath()` (stroke) | `gtk_snapshot_append_stroke()` |
| `drawText()` | `gtk_snapshot_append_layout()` (Pango) |
| `drawRoundRect()` | `gtk_snapshot_push_rounded_clip()` + `append_color/border` |
| `drawLine()` | 坐标变换 + `append_color()` |
| `save()` / `restore()` | `gtk_snapshot_save()` / `gtk_snapshot_restore()` |
| `clipRect()` | `gtk_snapshot_push_clip()` |
| `translate()` | `gtk_snapshot_translate()` |
| `rotate()` | `gtk_snapshot_rotate()` |
| `scale()` | `gtk_snapshot_scale()` |
| `concat(Matrix)` | `gtk_snapshot_transform_matrix()` |

以 `drawRect` 为例（`src/api-impl-jni/graphics/android_atl_GskCanvas.c`）：

```c
// src/api-impl-jni/graphics/android_atl_GskCanvas.c
JNIEXPORT void JNICALL
Java_android_atl_GskCanvas_native_1drawRect(JNIEnv *env,
    jclass this_class, jlong snapshot_ptr,
    jfloat left, jfloat top, jfloat right, jfloat bottom,
    jlong paint_ptr)
{
    GtkSnapshot *snapshot = GTK_SNAPSHOT(_PTR(snapshot_ptr));
    struct AndroidPaint *paint = _PTR(paint_ptr);
    graphene_rect_t bounds = GRAPHENE_RECT_INIT(
        left, top, right - left, bottom - top);
    gtk_snapshot_append_color(snapshot, &paint->color, &bounds);
}
```

`drawText` 的实现使用了 Pango 进行文本排版：

```c
// src/api-impl-jni/graphics/android_atl_GskCanvas.c
JNIEXPORT void JNICALL
Java_android_atl_GskCanvas_native_1drawText(JNIEnv *env,
    jclass this_class, jlong snapshot_ptr, jstring text,
    jfloat x, jfloat y, jlong paint_ptr)
{
    struct AndroidPaint *paint = _PTR(paint_ptr);
    PangoLayout *layout = pango_layout_new(
        gtk_widget_get_pango_context(window));
    pango_layout_set_font_description(layout, paint->font);
    const char *str = (*env)->GetStringUTFChars(env, text, NULL);
    pango_layout_set_text(layout, str, -1);
    // ... 基线和对齐计算 ...
    gtk_snapshot_append_layout(snapshot, layout, &paint->color);
}
```

### Snapshot 安全性问题

这里存在一个微妙但关键的问题：GTK4 严格禁止在 snapshot（绘制）过程中执行布局操作（如改变 label 文本、请求重新分配大小等）。但 Android 并没有这个限制——应用可以在 `onDraw()` 里随意调用 `setText()` 或者触发布局变更。

ATL 通过 tick callback 机制解决这个问题（`src/api-impl-jni/util.c`）：

```c
// src/api-impl-jni/util.c
extern int snapshot_in_progress;

void atl_safe_gtk_label_set_text(GtkLabel *label, const char *str)
{
    if (!snapshot_in_progress) {
        gtk_label_set_text(label, str);
    } else {
        gtk_widget_add_tick_callback(GTK_WIDGET(label),
            queue_set_text, (gpointer)strdup(str), NULL);
    }
}

void atl_ensure_widget_snapshotability(GtkWidget *widget)
{
    if (snapshot_in_progress) {
        GtkAllocation allocation;
        gtk_widget_get_allocation(widget, &allocation);
        gtk_widget_get_request_mode(widget);
        gtk_widget_size_allocate(widget, &allocation,
            gtk_widget_get_baseline(widget));
        GtkWidget *parent = gtk_widget_get_parent(widget);
        if (parent)
            atl_ensure_widget_snapshotability(parent);
    }
}
```

`snapshot_in_progress` 是一个全局计数器，在 `WrapperWidget` 的 `snapshot` 回调中递增/递减。当检测到处于 snapshot 阶段时，布局变更操作会被推迟到下一个 tick callback 中执行。对于已经产生的脏标记，`atl_ensure_widget_snapshotability()` 会向上遍历 widget 树，逐层清理，防止 GTK 的内部断言失败。

---

## 6. Widget 实现模式：以 TextView 为例

### AOSP 怎么做

AOSP 的 `TextView` 是一个约 12,000 行的庞然大物，内部实现了文本编辑、富文本渲染、输入法交互、自动链接检测等大量功能，底层使用 Skia 进行文字绘制。

### ATL 怎么做

ATL 将 `TextView` 映射为一个 `GtkLabel`（包裹在 `GtkBox` 中以支持 compound drawables），通过 JNI 桥接 Java 属性设置到 GTK/Pango API。

Java 侧（`src/api-impl/android/widget/TextView.java`）的构造器从 XML 属性中提取配置：

```java
// src/api-impl/android/widget/TextView.java
public TextView(Context context, AttributeSet attrs,
                int defStyleAttr, int defStyleRes) {
    super(context, attrs, defStyleAttr, defStyleRes);
    TypedArray a = context.obtainStyledAttributes(attrs,
        com.android.internal.R.styleable.TextView, defStyleAttr, 0);
    try {
        if (a.hasValue(R.styleable.TextView_text))
            setText(a.getText(R.styleable.TextView_text));
        if (a.hasValue(R.styleable.TextView_textColor))
            setTextColor(a.getColorStateList(
                R.styleable.TextView_textColor));
        if (a.hasValue(R.styleable.TextView_textSize))
            setTextSize(a.getDimensionPixelSize(
                R.styleable.TextView_textSize, 10));
        // ... textStyle, textAllCaps ...
    } catch (Exception e) { e.printStackTrace(); }
    a.recycle();
}
```

C 侧的 `native_constructor`（`src/api-impl-jni/widgets/android_widget_TextView.c`）创建 GTK 组件：

```c
// src/api-impl-jni/widgets/android_widget_TextView.c
JNIEXPORT jlong JNICALL
Java_android_widget_TextView_native_1constructor(
    JNIEnv *env, jobject this, jobject context, jobject attrs)
{
    const char *text = attribute_set_get_string(
        env, attrs, "text", NULL);
    GtkWidget *wrapper = g_object_ref(wrapper_widget_new());
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
    GtkWidget *label = gtk_label_new(text);
    gtk_label_set_wrap(GTK_LABEL(label), TRUE);
    gtk_label_set_xalign(GTK_LABEL(label), 0.f);
    gtk_widget_set_hexpand(label, TRUE);
    gtk_box_append(GTK_BOX(box), label);
    wrapper_widget_set_child(WRAPPER_WIDGET(wrapper), box);
    wrapper_widget_set_jobject(WRAPPER_WIDGET(wrapper), env, this);
    PangoAttrList *pango_attrs = pango_attr_list_new();
    pango_attr_list_insert(pango_attrs,
        pango_attr_font_features_new("tnum"));
    gtk_label_set_attributes(GTK_LABEL(label), pango_attrs);
    return _INTPTR(box);
}
```

完整的初始化流程如下：

```
XML 布局解析
  → TypedArray 提取属性 (text, textColor, textSize...)
    → Java 构造器调用 native_constructor (JNI)
      → 创建 WrapperWidget + GtkBox + GtkLabel
      → PangoAttrList 配置字体特性 (tnum)
      → wrapper_widget_set_jobject() 关联 Java 对象
    → setText() → native_setText() → atl_safe_gtk_label_set_text()
    → setTextColor() → native_setTextColor() → GtkCssProvider
    → setTextSize() → PangoAttribute (size)
```

文字颜色设置通过动态创建 CSS 实现：

```c
// src/api-impl-jni/widgets/android_widget_TextView.c
GtkCssProvider *css_provider = gtk_css_provider_new();
char *css_string = g_markup_printf_escaped(
    "* { color: #%06x%02x; }",
    color & 0xFFFFFF, (color >> 24) & 0xFF);
gtk_css_provider_load_from_string(css_provider, css_string);
gtk_style_context_add_provider(style_context,
    GTK_STYLE_PROVIDER(css_provider),
    GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
```

其他 Widget（Button、ImageView、EditText、ListView 等）遵循相同的模式：Java 侧提取属性，JNI 侧创建对应的 GTK Widget 组合，通过 WrapperWidget 包装。

---

## 7. 系统服务：从 Binder IPC 到 new

### AOSP 怎么做

在标准 Android 中，`getSystemService("audio")` 会通过 `ServiceManager.getService()` 获取一个 Binder 代理对象，这个代理对象与运行在 SystemServer 进程中的 `AudioService` 通信。几乎所有系统服务都是跨进程的，客户端持有的只是一个 Binder 代理。

```
App 进程                       SystemServer 进程
getSystemService("audio")
  → ServiceManager               AudioService
      .getService("audio")   ←→    (真正的实现)
        → Binder 代理
```

### ATL 怎么做

ATL 没有 SystemServer 进程，所有"系统服务"都在应用进程内直接实例化。`ContextImpl.java` 中的 `getSystemService()` 就是一个朴素的 switch 语句（`src/api-impl/android/app/ContextImpl.java`）：

```java
// src/api-impl/android/app/ContextImpl.java
public Object getSystemService(String name) {
    switch (name) {
        case "window":       return new WindowManagerImpl();
        case "audio":        return new AudioManager();
        case "sensor":       return new SensorManager();
        case "connectivity": return new ConnectivityManager();
        case "vibrator":
            return (vibrator != null) ? vibrator
                                      : (vibrator = new Vibrator());
        case "clipboard":    return new ClipboardManager();
        case "notification": return new NotificationManager();
        case "input_method": return new InputMethodManager();
        case "layout_inflater": return layout_inflater;
        case "jobscheduler": return job_scheduler;
        // ... 总计 30+ 个 case ...
        default:
            Slog.e(TAG, "getSystemService: case >"
                        + name + "< is not implemented yet");
            return null;
    }
}
```

当前已实现的系统服务包括：

| 服务名 | ATL 实现类 | 说明 |
|---|---|---|
| `audio` | `AudioManager` | 音频管理 |
| `sensor` | `SensorManager` | 传感器（部分桩实现） |
| `connectivity` | `ConnectivityManager` | 网络状态 |
| `clipboard` | `ClipboardManager` | 剪贴板 |
| `vibrator` | `Vibrator` | 震动反馈 |
| `notification` | `NotificationManager` | 通知 |
| `input_method` | `InputMethodManager` | 输入法 |
| `display` | `DisplayManager` | 显示管理 |
| `window` | `WindowManagerImpl` | 窗口管理 |
| `location` | `LocationManager` | 位置（桩实现） |
| `wifi` | `WifiManager` | WiFi（桩实现） |
| `bluetooth` | `BluetoothManager` | 蓝牙（桩实现） |
| `camera` | `CameraManager` | 相机 |
| `storage` | `StorageManager` | 存储管理 |

### 为什么这样做

对于单应用场景，跨进程隔离毫无意义。直接 `new` 一个对象比建立 Binder 连接简单几个数量级，而且避免了序列化/反序列化的开销。部分服务（如 `WifiManager`、`LocationManager`）主要提供桩实现——返回合理的默认值以避免应用崩溃，但不提供真实功能。

---

## 8. Binder/Parcel/Intent 的处理

### Binder：全部桩实现

Android 的 Binder 是整个系统的通信脊柱，但在 ATL 中完全是空壳。

`Binder.java`（`src/api-impl/android/os/Binder.java`）仅 29 行：

```java
// src/api-impl/android/os/Binder.java
public class Binder implements IBinder {
    public void attachInterface(IInterface owner, String descriptor) {}
    public static void flushPendingCommands() {}
    public static long clearCallingIdentity() { return 0; }
    public IInterface queryLocalInterface(String descriptor) {
        return null;
    }
    public boolean transact(int code, Parcel data, Parcel reply,
                            int flags) { return false; }
}
```

`IBinder.java` 仅 10 行，`ServiceManager.java` 仅 7 行——`getService()` 永远返回 `null`。

### Parcel：纯 Java 字节数组序列化

虽然 Binder 被桩掉了，但 `Parcel` 类被完整重写了。AOSP 中 Parcel 依赖 native 代码操作共享内存，ATL 中则用纯 Java 的 `byte[]` 加 `DataInputStream`/`DataOutputStream` 实现（`src/api-impl/android/os/Parcel.java`）。

`writeValue()`/`readValue()` 使用类型标签来区分不同数据类型：

| 标签值 | 类型 | 标签值 | 类型 |
|---|---|---|---|
| 0 | null | 8 | String |
| 1 | Byte | 9 | byte[] |
| 2 | Short | 10 | int[] |
| 3 | Integer | 14 | Bundle |
| 4 | Long | 15 | Parcelable |
| 5 | Float | 18 | List |
| 6 | Double | 19 | Map |
| 7 | Boolean | 22 | Serializable |

```java
// src/api-impl/android/os/Parcel.java (writeValue 片段)
public void writeValue(Object value) {
    if (value == null)        { writeInt(0); }
    else if (value instanceof Integer) {
        writeInt(3);
        writeInt(((Integer)value).intValue());
    } else if (value instanceof String) {
        writeInt(8);
        writeString((String)value);
    } else if (value instanceof Parcelable) {
        writeInt(15);
        writeParcelable((Parcelable)value, 0);
    }
    // ... 共 23 种类型 ...
}
```

这使得应用中使用 `Bundle`（底层依赖 Parcel）传递数据的代码可以正常工作。

### Intent 跨应用通信：GVariant + DBus

对于同一进程内的 Intent（如启动同一 APK 内的另一个 Activity），ATL 直接通过反射实例化目标 Activity。

但对于跨应用 Intent，ATL 使用 Freedesktop 的 DBus `ActivateAction` 接口。Intent 被序列化为类型为 `(sssa{sv}s)` 的 GVariant：

```
(action: s,        // Intent action 字符串
 className: s,     // 目标组件类名
 data: s,          // Intent data URI
 extras: a{sv},    // 额外数据（键值对）
 sender_dbus_name: s)  // 发送方 DBus 名称
```

详见 `doc/DBusIntentApi.md`。

### startService / bindService：进程内反射

`Context.java`（`src/api-impl/android/content/Context.java`）中的 `startService()` 和 `bindService()` 使用反射在当前进程内实例化 Service：

```java
// src/api-impl/android/content/Context.java
public ComponentName startService(Intent intent) {
    // ... 解析 component ...
    new Handler(Looper.getMainLooper()).post(() -> {
        Class<? extends Service> cls =
            Class.forName(className).asSubclass(Service.class);
        if (!runningServices.containsKey(cls)) {
            Service service = cls.getConstructor().newInstance();
            service.attachBaseContext(new ContextImpl(...));
            service.onCreate();
            runningServices.put(cls, service);
        }
        runningServices.get(cls).onStartCommand(intent, 0, 0);
    });
    return component;
}
```

`bindService()` 遵循相同的模式——通过反射实例化 Service 后，直接调用 `onBind()` 获取 IBinder，然后同步调用 `ServiceConnection.onServiceConnected()`。唯一的区别是这些调用被 post 到主 Looper 中异步执行，以模拟 Android 中 Service 绑定的异步语义。

---

## 9. framework-res.apk 裁剪

### AOSP 怎么做

`frameworks/base/core/res/` 目录包含了 Android 框架的资源文件：主题定义（`themes.xml`）、系统 Drawable（图标、背景等）、布局文件、动画定义等。编译后生成 `framework-res.apk`，其中包含上万个资源。

### ATL 怎么做

ATL 不需要 SystemUI 相关的资源（状态栏图标、导航栏等），但需要保留属于公开 API 的资源（如默认主题、标准颜色、系统 Drawable 等）。

`res/framework-res/remove_unused_resources.py` 实现了一个可达性分析算法：

```python
# res/framework-res/remove_unused_resources.py
# 从 public.xml、themes、styles、colors、xml 资源及 Manifest 等入口开始
xml_files_new = glob.glob("res/values/public*.xml")
xml_files_new += glob.glob("res/values*/themes*.xml")
xml_files_new += glob.glob("res/values*/styles*.xml")
xml_files_new += glob.glob("res/values*/colors*.xml")
xml_files_new += glob.glob("res/xml*/*.xml")
xml_files_new += glob.glob("AndroidManifest.xml")
# 递归查找所有被引用的资源
while len(xml_files_new) > 0:
    xml_files += xml_files_new
    for f in xml_files_old:
        # 解析 @drawable/xxx, @layout/xxx 等引用
        for pattern in ['name="(.*?)"',
                        '"@drawable/(.*?)"', ...]:
            # 如果引用的资源文件存在，加入待扫描队列
# 删除所有未被引用的 layout 和 drawable
for f in glob.glob("res/drawable*/*"):
    if not os.path.basename(f).split(".")[0] in resources:
        os.remove(f)
```

算法从 `public.xml`、`themes*.xml`、`styles*.xml`、`colors*.xml`、`res/xml*/` 以及 `AndroidManifest.xml`（声明了所有公开资源 ID 和配置入口）出发，递归追踪 `@drawable/`、`@layout/`、`@color/` 等资源引用，构建可达资源集合，然后删除所有不可达的 layout 和 drawable 文件。

效果：原始框架资源包含一万多个资源文件，裁剪后保留约 2,571 个文件，APK 从约 14MB 缩减到 3.9MB。

构建逻辑（`res/framework-res/meson.build`）：

```python
# res/framework-res/meson.build
aapt = find_program('aapt', required: false)
if aapt.found()
  aapt_command = [aapt, 'package', '-x', '-f',
    '--custom-package', 'com.android.internal',
    '-S', join_paths(dir_base, 'res/framework-res/res'),
    '-M', join_paths(dir_base, 'res/framework-res/AndroidManifest.xml'),
    '-J', join_paths(dir_base, 'src/api-impl/com/android/internal'),
    '-F', '@OUTPUT@']
else
  aapt_command = ['cp', join_paths(dir_base,
    'res/framework-res/framework-res.apk'), '@OUTPUT@']
endif
```

如果系统安装了 `aapt`，则从源码资源编译生成 APK 并同时生成 `R.java`；否则回退到使用预构建的 APK 文件。

---

## 总结

ATL 的 Java Framework 重实现展示了一个关键洞察：Android Framework 的大部分复杂性来自多进程架构的需要（Binder IPC、SystemServer、AMS 等），而在单进程翻译层场景下，这些复杂性可以被大幅简化。

核心技术决策包括：

1. **Activity 生命周期**：GList 栈 + JNI 直接调用，替代 AMS + Binder IPC
2. **View 体系**：WrapperWidget 双层架构，按需注册事件控制器
3. **Canvas 绘制**：即时模式到保留模式的逐方法翻译，加上 snapshot 安全机制
4. **系统服务**：`switch` + `new` 替代 ServiceManager + Binder 代理
5. **Binder/Parcel**：Binder 桩掉，Parcel 用纯 Java 重写
6. **框架资源**：可达性分析裁剪，从 14MB 到 3.9MB

下一篇将探讨 ATL 如何重实现 Android NDK（C/C++ 原生）API：[NDK API 重实现](atl-03-ndk-api-reimplementation.md)
