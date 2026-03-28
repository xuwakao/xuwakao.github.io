---
title: "ATL深度解析（3）NDK API 重实现 — 让 Native 游戏跑在 Linux 上"
description: "分析 ATL 如何重新实现 Android NDK API，让使用 OpenGL ES、Vulkan、OpenSL ES 的 Native 应用和游戏在 Linux 上运行"
pubDatetime: 2025-11-20T00:00:00Z
modDatetime: 2025-11-20T00:00:00Z
author: "xuwakao"
slug: "atl-ndk-api-reimplementation"
tags:
  - android
  - linux
  - atl
  - ndk
  - native
featured: false
---

# NDK API 重实现 — 让 Native 游戏跑在 Linux 上

> 本文是 ATL (Android Translation Layer) 系列分析的第三篇。前两篇分别介绍了 ATL 的整体架构和 Java API 兼容层。本篇将深入剖析 ATL 如何在 Linux 桌面环境中重新实现 Android NDK 的核心 C/C++ API，使得原本依赖 SurfaceFlinger、Hardware Composer 等 Android 系统服务的原生游戏和应用能够直接运行在 Wayland/X11 之上。

---

## 1. 概念铺垫：NDK 是什么

Android NDK（Native Development Kit）为开发者提供了一套 C/C++ API，允许应用绕过 Java 层直接调用底层系统功能。NDK 定义的关键头文件包括：

- `<android/native_window.h>` -- 窗口和 Surface 管理
- `<android/looper.h>` -- 事件循环（基于 epoll 的消息泵）
- `<android/asset_manager.h>` -- APK 内嵌资源读取
- `<android/sensor.h>` -- 传感器访问
- `<android/input.h>` -- 触摸、键盘等输入事件

NDK 最典型的用户是**游戏引擎**（Unity、Unreal Engine、Godot）、**媒体处理应用**和 **VR 应用**。这些应用的 APK 中包含预编译的 `.so` 共享库，它们在编译时链接了 `libandroid.so`、`libEGL.so`、`libGLESv2.so` 等 Android 系统库。

在 AOSP 中，这些 API 的背后是一整套系统服务链条：

```
ANativeWindow --> BufferQueue --> SurfaceFlinger --> Hardware Composer --> 显示硬件
ALooper       --> epoll wrapper (libutils 中的 C++ 实现)
AAssetManager --> AssetManager (libandroidfw)
```

当应用调用 `ANativeWindow_fromSurface()` 获取一个窗口句柄时，Android 内部会创建一个与 SurfaceFlinger 通信的 BufferQueue，最终将渲染结果合成到屏幕上。在 Linux 桌面上，这些系统服务并不存在 -- ATL 需要用 Wayland/X11 的原语来替代它们。

---

## 2. ATL 的 libandroid.so 重实现

ATL 将所有 NDK API 实现集中在一个共享库中。构建定义位于项目根目录的 `meson.build` 第 56-78 行：

```meson
# src: meson.build:56-78
libandroid_so = shared_library('android', [
    'src/libandroid/asset_manager.c',
    'src/libandroid/bitmap.c',
    'src/libandroid/configuration.c',
    'src/libandroid/egl.c',
    'src/libandroid/input.c',
    'src/libandroid/looper.c',
    'src/libandroid/media.c',
    'src/libandroid/native_window.c',
    'src/libandroid/sensor.c',
    'src/libandroid/trace.c',
],
install: true,
soversion: 0,   # --> 生成 libandroid.so.0
```

共 10 个 C 源文件加上 3 个头文件（`native_window.h`、`looper.h`、`bitmap.h`），构建产物为 `libandroid.so.0`。依赖项包括 GTK4、JNI、Vulkan 和 OpenXR。

当 Android 应用通过 bionic 链接器加载 `libandroid.so` 时，bionic_translation 的配置文件会将其映射到宿主系统的对应库。映射规则定义在 `bionic_translation/cfg.d/bionic_translation.cfg` 中：

```
# src: bionic_translation/cfg.d/bionic_translation.cfg
libandroid.so       libandroid.so.0
libopenxr_loader.so libopenxr_loader.so.1
libEGL.so           libEGL.so.1
libGLESv2.so        libGLESv2.so.2
libGLESv3.so        libGLESv2.so.2   # GLESv3 是 GLESv2 的符号链接
```

这意味着当游戏调用 `dlopen("libandroid.so", ...)` 时，bionic_translation 的 shim 链接器会去加载宿主系统上的 `libandroid.so.0` -- 即 ATL 编译出的重实现版本。同理，EGL 和 GLES 调用被直接转发到桌面 Linux 的 Mesa/NVIDIA 驱动所提供的 `libEGL.so.1` 和 `libGLESv2.so.2`。

> **注意**：音频 API（OpenSLES）不包含在 ATL 的 `libandroid.so` 中，而是由独立项目 `libopensles-standalone` 提供。其映射同样在 `bionic_translation.cfg` 中配置：`libOpenSLES.so → libOpenSLES.so.1`。

---

## 3. ANativeWindow：从 SurfaceFlinger 到 Wayland/X11

### AOSP 原理

在 Android 中，`ANativeWindow` 是应用获取渲染目标的核心抽象。调用链为：

```
ANativeWindow_fromSurface()
  --> 获取 Surface 对象关联的 BufferQueue (IGraphicBufferProducer)
  --> dequeueBuffer / queueBuffer 与 SurfaceFlinger 交互
  --> SurfaceFlinger 合成到 Hardware Composer
  --> 输出到显示屏
```

### ATL 实现

ATL 将 `ANativeWindow` 定义为一个包含 Wayland 和 X11 双后端信息的结构体：

```c
// src: src/libandroid/native_window.h
struct ANativeWindow {
    EGLNativeWindowType egl_window;
    GtkWidget *surface_view_widget;
    struct wl_display *wayland_display;
    struct wl_surface *wayland_surface;
    Display *x11_display;
    gulong resize_handler;
    int refcount;
    int width;
    int height;
};
```

ATL 为 `ANativeWindow` 提供了两种渲染模式，由环境变量 `ATL_DIRECT_EGL` 控制：

- **默认模式**（不设置 `ATL_DIRECT_EGL`）：不创建平台原生子窗口，渲染通过 EGL 三缓冲 ATLSurface 实现（详见下一节），最终以 GdkTexture 形式展示在 GTK Widget 中。这是大多数应用使用的路径。
- **直接 EGL 模式**（设置 `ATL_DIRECT_EGL`）：在 GTK 窗口内创建平台原生子窗口（Wayland subsurface 或 X11 子窗口），应用直接渲染到这个子窗口。延迟更低，但灵活性较差。

核心逻辑在 `src/libandroid/native_window.c` 的 `ANativeWindow_fromSurface()` 函数中（第 253-387 行）。以下描述直接 EGL 模式下的平台原生窗口创建路径：

**Wayland 路径**（`ATL_DIRECT_EGL` 模式）的创建流程：

```c
// src: src/libandroid/native_window.c (Wayland 路径，简化)
struct wl_surface *wayland_surface = wl_compositor_create_surface(wl_compositor);
struct wl_subsurface *subsurface = wl_subcompositor_get_subsurface(
    wl_subcompositor, wayland_surface, toplevel_surface);
wl_subsurface_set_desync(subsurface);
wl_subsurface_set_position(subsurface, pos.x, pos.y);

// 设置空输入区域，让输入穿透到 GTK 窗口
struct wl_region *empty_region = wl_compositor_create_region(wl_compositor);
wl_surface_set_input_region(wayland_surface, empty_region);

struct wl_egl_window *egl_window = wl_egl_window_create(wayland_surface, width, height);
native_window->egl_window = (EGLNativeWindowType)egl_window;
```

这段代码的关键设计是：在 GTK 的顶级 Wayland 窗口下方创建一个**子表面**（subsurface），Android 应用渲染到这个子表面上。同时将子表面的输入区域设为空，这样触摸和鼠标事件仍然由 GTK 接收，再转换为 Android 输入事件。

**X11 路径**（同样在 `ATL_DIRECT_EGL` 模式下）同样巧妙：

```c
// src: src/libandroid/native_window.c (X11 路径，简化)
Window x11_window = XCreateSimpleWindow(x11_display,
    DefaultRootWindow(x11_display), 0, 0, width, height, 0, 0, 0xffffffff);
XReparentWindow(x11_display, x11_window, toplevel_window, 0, 0);
XMapWindow(x11_display, x11_window);

// 使窗口可被点击穿透
Region region = XCreateRegion();
XShapeCombineRegion(x11_display, x11_window, ShapeInput, 0, 0, region, ShapeSet);
```

这里先在根窗口下创建 X11 窗口，再 reparent 到 GTK 的顶级窗口。注释中解释了原因：NVIDIA 驱动下 GTK 窗口选择的 visual 模式与 NVIDIA 的 EGL 实现不兼容，所以需要先在默认根窗口下创建，再挪过去。使用 XShape 扩展将输入区域清空，实现点击穿透。

整体架构可以用如下 ASCII 图示概括：

```
  Android App (.so)
       |
       | ANativeWindow_fromSurface()
       v
  +--------------------+
  | struct ANativeWindow|
  +--------------------+
       |
  +---------+-----------+
  | Wayland |    X11    |
  +---------+-----------+
  |wl_egl_  |XCreate    |
  |window   |SimpleWin  |
  |  +      |  +        |
  |wl_sub-  |XReparent  |
  |surface  |Window     |
  +---------+-----------+
       |
       v
  GTK4 顶级窗口 (GtkWindow)
```

---

## 4. EGL 三缓冲 ATLSurface

### 问题陈述

Android 应用认为自己在直接渲染到屏幕，但 ATL 需要将渲染结果捕获为 GTK 纹理，再通过 GTK 的合成管线显示。这就引出了 ATL 中最精巧的组件之一：`ATLSurface` 三缓冲系统。

### ATLSurface 结构

```c
// src: src/libandroid/egl.c:194-215
#define NUM_BUFFERS 3

struct _ATLSurface {
    GObject parent;
    int width;
    int height;
    SurfaceViewWidget *surface_view_widget;
    int32_t framebuffer_format;
    int32_t renderbuffer_format;
    unsigned int renderbuffer_attachment;
    uint32_t renderbuffer;
    struct atl_surface_buffer {
        struct _ATLSurface *surface;
        EGLImage egl_image;
        GdkGLTextureBuilder *texture_builder;
        uint32_t gl_texture;
        uint32_t gl_framebuffer;
    } buffers[NUM_BUFFERS];
    struct atl_surface_buffer *back_buffer;
    struct atl_surface_buffer *front_buffer;
    GAsyncQueue *vsync;
    GAsyncQueue *unused_buffers;
    gboolean destroyed;
};
```

每个缓冲区（buffer）包含三个关联的 GL 对象：一个 `EGLImage`（用于跨上下文共享）、一个 `gl_texture`（纹理）和一个 `gl_framebuffer`（帧缓冲区）。三个缓冲区通过 `GAsyncQueue` 在渲染线程和 GTK 主线程之间流转。

### 数据流

整个三缓冲机制的流转如下：

```
                     渲染线程                      GTK 主线程
                        |                              |
  unused_buffers队列 ---pop--> back_buffer             |
                        |                              |
           glBindFramebuffer(back_buffer->fbo)         |
                        |                              |
              App 渲染到 FBO                            |
                        |                              |
         eglSwapBuffers:                               |
           glFlush()                                   |
           等待 vsync 信号                              |
           back_buffer --> front_buffer                |
           g_idle_add(queue_texture)  --------->  queue_texture():
                        |                         EGLImage-->GTK纹理
         pop新back_buffer                         surface_view_set_texture()
           从unused队列                            buffer-->unused_buffers队列
                        |                              |
```

### 关键拦截函数

**bionic_eglGetDisplay()** -- 忽略 Android 传入的 `EGL_DEFAULT_DISPLAY`，转而从 GTK 获取实际显示连接：

```c
// src: src/libandroid/egl.c:95-116
EGLDisplay bionic_eglGetDisplay(EGLNativeDisplayType native_display)
{
    GdkDisplay *display = gtk_root_get_display(GTK_ROOT(window));
    if (GDK_IS_WAYLAND_DISPLAY(display)) {
        struct wl_display *wl_display = gdk_wayland_display_get_wl_display(display);
        return eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR, wl_display, NULL);
    } else if (GDK_IS_X11_DISPLAY(display)) {
        Display *x11_display = gdk_x11_display_get_xdisplay(display);
        return eglGetPlatformDisplay(EGL_PLATFORM_X11_KHR, x11_display, NULL);
    }
    return NULL;
}
```

这一步至关重要。在 Wayland 上，不同的 `wl_display` 对应不同的 EGL 显示上下文。SDL 等框架在 Android 上习惯传 0（`EGL_DEFAULT_DISPLAY`），在 Wayland 上这会得到错误的显示上下文。ATL 直接从 GTK 的 `GdkDisplay` 中提取底层连接来保证一致性。

**bionic_eglChooseConfig()** -- 针对 Wayland 移除 `EGL_PBUFFER_BIT`：

```c
// src: src/libandroid/egl.c:118-152 (简化)
EGLBoolean bionic_eglChooseConfig(EGLDisplay display, EGLint *attrib_list, ...)
{
    if (GDK_IS_X11_DISPLAY(gdk_display)) {
        return eglChooseConfig(display, attrib_list, ...);  // X11 支持 pbuffer
    } else {
        // Wayland 不支持 EGL pbuffer，去掉该标志位并替换为 EGL_WINDOW_BIT
        // ... 复制属性列表，修改 EGL_SURFACE_TYPE ...
        *(attr + 1) &= ~EGL_PBUFFER_BIT;
        *(attr + 1) |= EGL_WINDOW_BIT;
    }
}
```

许多 Android 应用请求同时支持 WINDOW 和 PBUFFER 的配置，但 Wayland 的 EGL 实现不提供 pbuffer 支持，直接传递会导致 `eglChooseConfig` 返回 0 个匹配配置。

**bionic_eglMakeCurrent()** -- 初始化三缓冲池并绑定 FBO：

此函数在首次调用时创建所有三个缓冲区的纹理、EGLImage 和 FBO，然后从 `unused_buffers` 队列中弹出一个作为当前 back buffer，并将其 FBO 绑定为渲染目标。这样后续所有 `glDraw*` 调用都会渲染到 ATL 的离屏缓冲区而非屏幕。

**bionic_glBindFramebuffer()** -- 拦截 FBO 0 的绑定：

```c
// src: src/libandroid/egl.c:498-504
void bionic_glBindFramebuffer(GLenum target, GLuint framebuffer)
{
    if (getenv("ATL_DIRECT_EGL") || framebuffer != 0)
        return glBindFramebuffer(target, framebuffer);
    ATLSurface *atl_surface = g_hash_table_lookup(draw_surface_hashtable, eglGetCurrentContext());
    return glBindFramebuffer(target, atl_surface ? atl_surface->back_buffer->gl_framebuffer : 0);
}
```

在 OpenGL 中，FBO 0 代表默认帧缓冲区（即屏幕）。当应用调用 `glBindFramebuffer(GL_FRAMEBUFFER, 0)` 试图绑定到"屏幕"时，ATL 将其重定向到当前 back buffer 的 FBO，确保渲染仍然发生在离屏纹理中。

**bionic_eglSwapBuffers()** -- 提交渲染结果：

```c
// src: src/libandroid/egl.c:441-465 (简化)
EGLBoolean bionic_eglSwapBuffers(EGLDisplay display, EGLSurface surface)
{
    ATLSurface *atl_surface = surface;
    glFlush();
    if (atl_surface->back_buffer) {
        g_async_queue_timeout_pop(atl_surface->vsync, 50000);  // 等待 vsync
        atl_surface->front_buffer = atl_surface->back_buffer;
        atl_surface->back_buffer = NULL;
        g_idle_add_full(G_PRIORITY_HIGH_IDLE + 20, queue_texture,
                        g_object_ref(atl_surface), NULL);
    }
    atl_surface->back_buffer = g_async_queue_timeout_pop(
        atl_surface->unused_buffers, 100000);  // 获取下一个可用缓冲区
    if (atl_surface->back_buffer)
        glBindFramebuffer(GL_FRAMEBUFFER, atl_surface->back_buffer->gl_framebuffer);
    return EGL_TRUE;
}
```

这里的步骤很清晰：先 `glFlush()` 确保 GPU 命令提交，然后等待来自 GTK 主线程的 vsync 信号（通过 `GAsyncQueue`），再将当前 back buffer 提升为 front buffer，通过 `g_idle_add` 调度在主线程上显示纹理，最后从 unused 队列中取出下一个缓冲区继续渲染。

此外，`bionic_eglPresentationTimeANDROID()` 被简单地 stub 为返回 `EGL_TRUE` -- 这是一个 Android 独有的扩展，用于精确控制帧呈现时间，在桌面环境中没有对应物。

---

## 5. ALooper：复用 ART 内部 C++ 实现

### 概念

Android 的 `ALooper` 是一个基于 `epoll` 的事件循环，原始实现位于 AOSP 的 `libutils` 中，以 C++ 类 `android::Looper` 的形式存在。NDK 暴露的是一套 C API（`ALooper_prepare`、`ALooper_pollAll` 等），内部调用 C++ 实现。

### ATL 的 C++ 符号名技巧

ATL 的 `art_standalone` 组件包含了完整的 ART 运行时，其中包括 `android::Looper` 的 C++ 实现。ATL 的策略是直接调用这些 C++ 方法，通过声明 mangled name（C++ 名称修饰后的符号）来实现：

```c
// src: src/libandroid/looper.c

// dummy strong pointer class -- 用于接收 C++ 智能指针返回值
struct sp {
    ALooper *ptr;
    char filler[16];  // aarch64 上大于 16 字节的结构体有不同的返回约定
};

struct sp _ZN7android6Looper12getForThreadEv(void);
ALooper *ALooper_forThread(void)
{
    return _ZN7android6Looper12getForThreadEv().ptr;
}

struct sp _ZN7android6Looper7prepareEi(int opts);
ALooper *ALooper_prepare(int opts)
{
    return _ZN7android6Looper7prepareEi(opts).ptr;
}

int _ZN7android6Looper7pollAllEiPiS1_PPv(ALooper *this, int timeoutMillis,
    int *outFd, int *outEvents, void **outData);
int ALooper_pollAll(int timeoutMillis, int *outFd, int *outEvents, void **outData)
{
    ALooper *looper = ALooper_forThread();
    if (!looper) {
        fprintf(stderr, "ALooper_pollAll: ALooper_forThread returned NULL\n");
        return 0;
    }
    return _ZN7android6Looper7pollAllEiPiS1_PPv(looper, timeoutMillis,
        outFd, outEvents, outData);
}
```

这段代码展示了几个精妙之处：

1. **C++ mangled name 映射**：`_ZN7android6Looper7prepareEi` 就是 `android::Looper::prepare(int)` 的 Itanium ABI mangled 名称。通过 `extern` 声明这些符号，链接器会在运行时从 `art_standalone` 的库中解析它们。

2. **智能指针包装**：C++ 方法返回 `android::sp<Looper>`（智能指针），ATL 用一个 `struct sp` 来接收。注释特别指出 `filler[16]` 的必要性：在 aarch64 上，超过 16 字节的结构体使用不同的调用约定（通过内存而非寄存器传递返回值），这必须与 C++ 端保持一致。

3. **完整的 ALooper API 覆盖**：包括 `ALooper_addFd`、`ALooper_removeFd`、`ALooper_wake`、`ALooper_acquire`、`ALooper_release`，甚至还有内部使用的 `ALooper_isPolling`。每个函数都是一个薄包装，将 NDK C API 转发到 C++ mangled name。

这种方法的优雅之处在于完全避免了重新实现 Looper 的复杂逻辑（epoll 管理、唤醒管道、回调调度等），而是直接复用了经过 Google 长期测试的 AOSP 原版代码。

---

## 6. AInput：GTK 事件到 Android 输入事件

### 事件模型差异

Android 的输入系统使用 `AInputQueue`/`AInputEvent` 模型：应用通过 `ALooper` 轮询输入队列，获取 `AInputEvent` 后读取坐标和动作类型。GTK 则基于信号/回调模型，事件由 `GtkEventController` 分发。

ATL 需要在两者之间建立一座桥梁。

### 数据结构

```c
// src: src/libandroid/input.c:70-74
struct AInputEvent {
    double x;
    double y;
    int32_t action;
};
```

结构体故意保持简洁 -- 目前只支持单点触控的位置和动作。注释中提到未来可能需要为不同事件类型使用不同结构体。

> **限制**：多点触控（multitouch）目前尚未支持。源码中有明确的 `TODO: this doesn't work for multitouch` 注释，且当前实现使用单一全局变量 `fixme_ugly_current_event` 来存储输入事件，无法同时追踪多个触控点。

### 管道传输机制

核心设计是使用 Unix pipe 将 GTK 事件传递到 ALooper：

```c
// src: src/libandroid/input.c:237-252 (简化)
void AInputQueue_attachLooper(struct input_queue *queue, struct ALooper *looper,
    int ident, Looper_callbackFunc callback, void *data)
{
    int input_queue_pipe[2];
    pipe(input_queue_pipe);
    fcntl(input_queue_pipe[0], F_SETFL, O_NONBLOCK);  // 读端非阻塞
    ALooper_addFd(looper, input_queue_pipe[0], ident,
                  ALOOPER_EVENT_INPUT, callback, data);
    g_signal_connect(queue->controller, "event",
                     G_CALLBACK(on_event), GINT_TO_POINTER(input_queue_pipe[1]));
    queue->fd = input_queue_pipe[0];
}
```

流程是：

```
GTK 事件 --> on_event 回调 --> write(pipe_fd, &ainput_event)
                                       |
                                  pipe (内核缓冲区)
                                       |
ALooper_pollAll() <-- epoll 监听 pipe_fd --> AInputQueue_getEvent() --> read(pipe_fd)
```

`on_event` 回调函数负责将 GDK 事件转换为 Android 输入事件：

```c
// src: src/libandroid/input.c:187-203 (make_touch_event 简化)
switch (gdk_event_get_event_type(event)) {
    case GDK_BUTTON_PRESS:
    case GDK_TOUCH_BEGIN:
        ainput_event->action = AMOTION_EVENT_ACTION_DOWN;
        break;
    case GDK_BUTTON_RELEASE:
    case GDK_TOUCH_END:
        ainput_event->action = AMOTION_EVENT_ACTION_UP;
        break;
    case GDK_MOTION_NOTIFY:
    case GDK_TOUCH_UPDATE:
        ainput_event->action = AMOTION_EVENT_ACTION_MOVE;
        break;
}
```

坐标转换也很关键：GTK 窗口的坐标系从标题栏左上角开始，而 Android 应用期望坐标从内容区域左上角开始。因此代码使用 `gtk_widget_compute_point()` 将坐标从窗口空间变换到子 widget 空间。

---

## 7. AAssetManager 和 AndroidBitmap

### AAssetManager

Android 的 `AAssetManager` 用于读取 APK 中 `assets/` 目录下的文件。ATL 的实现直接委托给 `libandroidfw` 的 C API：

```c
// src: src/libandroid/asset_manager.c:29-39
struct Asset *AAssetManager_open(struct AssetManager *asset_manager,
    const char *file_name, int mode)
{
    char *path = malloc(strlen(ASSET_DIR) + strlen(file_name) + 1);
    sprintf(path, "%s%s", ASSET_DIR, file_name);
    struct Asset *asset = AssetManager_openNonAsset(asset_manager, path, mode);
    free(path);
    return asset;
}
```

函数名的映射关系非常直接：`AAsset_read` 调用 `Asset_read`，`AAsset_getLength` 调用 `Asset_getLength`，`AAsset_close` 调用 `Asset_delete`，`AAssetDir_getNextFileName` 调用 `AssetDir_getFileName`。`libandroidfw` 本身能够解析 APK（实际上是 ZIP 文件）中的资源，ATL 复用了这个能力。

`AAssetManager_fromJava` 通过 JNI 从 Java 侧的 `AssetManager` 对象中提取原生指针：

```c
// src: src/libandroid/asset_manager.c:126-129
struct AssetManager *AAssetManager_fromJava(JNIEnv *env, jobject asset_manager)
{
    return _PTR(_GET_LONG_FIELD(asset_manager, "mObject"));
}
```

### AndroidBitmap

`AndroidBitmap_lockPixels` / `AndroidBitmap_unlockPixels` 是 NDK 中用于直接访问 Bitmap 像素数据的 API。在 Android 中，这涉及对 GraphicBuffer 的锁定。ATL 的实现基于 GDK 纹理：

```c
// src: src/libandroid/bitmap.c:20-49 (lockPixels 简化)
int AndroidBitmap_lockPixels(JNIEnv *env, jobject bitmap, void **pixels)
{
    GdkTexture *texture = _PTR((*env)->CallLongMethod(env, bitmap,
        _METHOD(_CLASS(bitmap), "getTexture", "()J")));
    GdkTextureDownloader *downloader = gdk_texture_downloader_new(texture);
    gdk_texture_downloader_set_format(downloader, format);
    GBytes *bytes = NULL;
    if (GDK_IS_MEMORY_TEXTURE(texture)) {  // 尝试零拷贝路径
        bytes = gdk_texture_downloader_download_bytes(downloader, &texture_stride);
        if (texture_stride != stride)  // stride 不匹配则回退
            bytes = NULL;
    }
    if (bytes == NULL) {  // 回退到拷贝路径
        guchar *data = g_malloc(stride * gdk_texture_get_height(texture));
        gdk_texture_downloader_download_into(downloader, data, stride);
        bytes = g_bytes_new_take(data, stride * gdk_texture_get_height(texture));
    }
    *pixels = (void *)g_bytes_get_data(bytes, NULL);
    return ANDROID_BITMAP_RESULT_SUCCESS;
}
```

注意零拷贝优化：如果纹理是 `GdkMemoryTexture`（即已经在 CPU 内存中），且 stride 匹配，则直接返回底层字节的指针，不做任何数据拷贝。

`AndroidBitmap_unlockPixels` 则在应用修改完像素后，用修改后的数据创建新的 `GdkMemoryTexture`：

```c
// src: src/libandroid/bitmap.c:52-74 (unlockPixels 简化)
int AndroidBitmap_unlockPixels(JNIEnv *env, jobject bitmap)
{
    GBytes *bytes = _PTR(_GET_LONG_FIELD(bitmap, "bytes"));
    GdkTexture *texture = gdk_memory_texture_new(width, height, format, bytes, stride);
    g_bytes_unref(bytes);
    (*env)->CallVoidMethod(env, bitmap, _METHOD(_CLASS(bitmap), "recycle", "()V"));
    _SET_LONG_FIELD(bitmap, "texture", _INTPTR(texture));
    return ANDROID_BITMAP_RESULT_SUCCESS;
}
```

---

## 8. Vulkan 透明转换

部分 Android 游戏使用 Vulkan 而非 OpenGL ES 进行渲染。Android 定义了 `VK_KHR_android_surface` 扩展来创建 Vulkan 渲染表面。ATL 将其透明地转换为 Wayland 或 X11 的 Vulkan 表面。

### vkCreateAndroidSurfaceKHR 的转换

```c
// src: src/libandroid/native_window.c:396-420 (简化)
VkResult bionic_vkCreateAndroidSurfaceKHR(VkInstance instance,
    const VkAndroidSurfaceCreateInfoKHR *pCreateInfo, ...)
{
    GdkDisplay *display = gtk_widget_get_display(
        pCreateInfo->window->surface_view_widget);
    if (GDK_IS_WAYLAND_DISPLAY(display)) {
        VkWaylandSurfaceCreateInfoKHR wayland_create_info = {
            .sType = VK_STRUCTURE_TYPE_WAYLAND_SURFACE_CREATE_INFO_KHR,
            .display = pCreateInfo->window->wayland_display,
            .surface = pCreateInfo->window->wayland_surface,
        };
        return vkCreateWaylandSurfaceKHR(instance, &wayland_create_info, ...);
    } else if (GDK_IS_X11_DISPLAY(display)) {
        VkXlibSurfaceCreateInfoKHR x11_create_info = {
            .sType = VK_STRUCTURE_TYPE_XLIB_SURFACE_CREATE_INFO_KHR,
            .dpy = pCreateInfo->window->x11_display,
            .window = pCreateInfo->window->egl_window,
        };
        return vkCreateXlibSurfaceKHR(instance, &x11_create_info, ...);
    }
}
```

转换逻辑干净利落：从 Android 的 `VkAndroidSurfaceCreateInfoKHR` 中提取 `ANativeWindow`，然后根据显示后端构造相应的 `VkWaylandSurfaceCreateInfoKHR` 或 `VkXlibSurfaceCreateInfoKHR`，再调用桌面 Vulkan 的对应函数。

### vkCreateInstance 的扩展注入

应用在创建 Vulkan 实例时会请求 `VK_KHR_android_surface` 扩展。ATL 需要额外注入桌面平台的扩展：

```c
// src: src/libandroid/native_window.c:422-434
VkResult bionic_vkCreateInstance(VkInstanceCreateInfo *pCreateInfo, ...)
{
    int original_extension_count = pCreateInfo->enabledExtensionCount;
    int new_extension_count = original_extension_count + 2;
    const char **enabled_exts = malloc(new_extension_count * sizeof(char *));
    memcpy(enabled_exts, pCreateInfo->ppEnabledExtensionNames, ...);
    enabled_exts[original_extension_count] = "VK_KHR_wayland_surface";
    enabled_exts[original_extension_count + 1] = "VK_KHR_xlib_surface";
    pCreateInfo->ppEnabledExtensionNames = enabled_exts;
    return vkCreateInstance(pCreateInfo, ...);
}
```

### vkGetInstanceProcAddr 拦截入口

```c
// src: src/libandroid/native_window.c:436-442
PFN_vkVoidFunction bionic_vkGetInstanceProcAddr(VkInstance instance, const char *pName)
{
    if (!strcmp(pName, "vkCreateInstance"))
        return (PFN_vkVoidFunction)bionic_vkCreateInstance;
    return vkGetInstanceProcAddr(instance, pName);
}
```

Vulkan 的函数指针查询机制使得 ATL 只需要拦截 `vkGetInstanceProcAddr` 一个入口点，就能将 `vkCreateInstance` 的调用重定向到自己的版本。整条拦截链只有三个函数，但足以让任何使用 Vulkan 的 Android 游戏透明地运行在桌面 Vulkan 驱动上。

---

## 9. OpenXR 适配（Oculus Quest 应用支持）

ATL 对 OpenXR 的适配可能是整个项目中最出人意料的功能。它使得为 Oculus Quest（Meta Quest）编写的 VR 应用有可能在桌面 VR 头显上运行。实现位于 `src/libandroid/native_window.c` 的第 446-605 行。

### 延迟加载

为了避免对 OpenXR 运行时的硬依赖（大多数用户不需要 VR），ATL 使用延迟加载：

```c
// src: src/libandroid/native_window.c:452-460
static void *openxr_loader_handle = NULL;
static inline __attribute__((__always_inline__)) XrResult xr_lazy_call(char *func_name, ...)
{
    if (!openxr_loader_handle)
        openxr_loader_handle = dlopen("libopenxr_loader.so.1", RTLD_LAZY);
    xr_func func = dlsym(openxr_loader_handle, func_name);
    return func(__builtin_va_arg_pack());
}
```

`__builtin_va_arg_pack` 是 GCC 扩展，允许将可变参数原封不动地传递给被调用函数，这使得 `xr_lazy_call` 可以作为任何 OpenXR 函数的通用延迟调用包装器。

### xrCreateInstance：扩展替换

Oculus Quest 应用请求 `XR_KHR_android_create_instance` 扩展，这在桌面端不存在。ATL 将其替换为桌面 VR 所需的扩展：

```c
// src: src/libandroid/native_window.c:507-543 (简化)
XrResult bionic_xrCreateInstance(XrInstanceCreateInfo *createInfo, ...)
{
    const char *harmless_extension = "XR_KHR_opengl_es_enable";
    const char *extra_exts[] = {
        "XR_MNDX_egl_enable",
        "XR_EXT_local_floor",
    };
    // 将 XR_KHR_android_create_instance 替换为无害的扩展
    for (int i = 0; i < createInfo->enabledExtensionCount; i++) {
        if (!strcmp(new_names[i], "XR_KHR_android_create_instance"))
            new_names[i] = harmless_extension;
    }
    // 追加桌面 VR 所需的扩展
    for (int i = 0; i < ARRAY_SIZE(extra_exts); i++)
        new_names[createInfo->enabledExtensionCount + i] = extra_exts[i];
    return xr_lazy_call("xrCreateInstance", createInfo, instance);
}
```

替换策略很巧妙：不是删除不需要的扩展（这需要移动数组元素），而是将其就地替换为 `XR_KHR_opengl_es_enable`（一个无害的扩展，应用本身很可能也在请求）。

### xrCreateSession：图形绑定转换

Android VR 应用使用 `XrGraphicsBindingOpenGLESAndroidKHR`，桌面端需要转换为 `XrGraphicsBindingEGLMNDX`：

```c
// src: src/libandroid/native_window.c:476-492
XrResult bionic_xrCreateSession(XrInstance instance,
    XrSessionCreateInfo *createInfo, XrSession *session)
{
    struct XrGraphicsBindingOpenGLESAndroidKHR *android_bind = createInfo->next;
    XrGraphicsBindingEGLMNDX egl_bind = {XR_TYPE_GRAPHICS_BINDING_EGL_MNDX};
    if (android_bind->type == XR_TYPE_GRAPHICS_BINDING_OPENGL_ES_ANDROID_KHR) {
        egl_bind.getProcAddress = eglGetProcAddress;
        egl_bind.display = android_bind->display;
        egl_bind.config = android_bind->config;
        egl_bind.context = android_bind->context;
        createInfo->next = &egl_bind;
    }
    return xr_lazy_call("xrCreateSession", instance, createInfo, session);
}
```

### xrCreateReferenceSpace：参考空间修补

Oculus 使用私有的参考空间类型（数值大于 100），ATL 将其统一映射到标准的 `XR_REFERENCE_SPACE_TYPE_LOCAL_FLOOR_EXT`：

```c
// src: src/libandroid/native_window.c:546-555
XrResult bionic_xrCreateReferenceSpace(XrSession session,
    const XrReferenceSpaceCreateInfo *createInfo, XrSpace *space)
{
    if (createInfo->referenceSpaceType > 100)
        *(int *)(&createInfo->referenceSpaceType) = XR_REFERENCE_SPACE_TYPE_LOCAL_FLOOR_EXT;
    return xr_lazy_call("xrCreateReferenceSpace", session, createInfo, space);
}
```

所有 OpenXR 拦截函数通过一张查找表暴露给 `xrGetInstanceProcAddr`，该表保持字母序排列以支持 `bsearch` 二分查找：

```c
// src: src/libandroid/native_window.c:582-588
static const struct xr_proc_override xr_proc_override_tbl[] = {
    XR_PROC_BIONIC(xrCreateInstance),
    XR_PROC_BIONIC(xrCreateReferenceSpace),
    XR_PROC_BIONIC(xrCreateSession),
    XR_PROC_BIONIC(xrGetInstanceProperties),
    XR_PROC_BIONIC(xrInitializeLoaderKHR),
};
```

源码中的注释坦率地将其称为"NIH OpenXR API layer"（自己造轮子的 OpenXR 层），并建议未来可能改为实现一个正规的 OpenXR layer 库。

---

## 10. Stub 策略

并非所有 NDK API 都需要完整实现。ATL 对暂时不需要或无法在桌面端提供的功能采用 stub（桩）策略，返回安全的默认值使应用不至于崩溃。

### 传感器 (sensor.c)

```c
// src: src/libandroid/sensor.c:33-41
struct ASensor const *ASensorManager_getDefaultSensor(struct ASensorManager *manager, int type)
{
    return NULL;  // 该类型的传感器不存在
}

int ASensorManager_getSensorList(struct ASensorManager *manager, struct ASensorList *list)
{
    return 0;  // 传感器数量为 0 -- 正常的应用看到这个结果后会放弃使用传感器
}
```

### 媒体编解码 (media.c)

整个 `AMediaCodec_*` 系列 API 全部返回错误值：大部分函数返回 `-1`（通用错误），少数返回 `AMEDIA_ERROR_UNKNOWN`（即 `-10000`）、`NULL` 或 `false`。这告诉应用硬件编解码不可用，促使其回退到软件解码路径。

### 配置 (configuration.c)

`AConfiguration_*` 系列的所有 getter 返回 `-1`（未设置），所有 setter 为空操作。`AConfiguration_new()` 直接返回 `NULL`。这些函数总共 40 多个，全部是无操作的 stub。

### 追踪 (trace.c)

最精简的 stub 文件只有 3 行有效代码：

```c
// src: src/libandroid/trace.c (完整文件)
#include <stdbool.h>

bool ATrace_isEnabled()
{
    return false;
}
```

`ATrace` 是 Android 的性能追踪 API（对应 systrace/perfetto）。返回 `false` 告诉应用追踪未启用，应用会跳过所有追踪代码路径，不会有任何副作用。

stub 策略的核心原则是：**返回一个能让应用优雅降级的值**。返回 NULL 表示"资源不存在"、返回 0 表示"列表为空"、返回 false 表示"功能未启用"、返回错误码表示"操作失败"。这些都是应用的错误处理路径会覆盖到的正常场景。

---

## 11. NativeActivity 加载流程

`NativeActivity` 是 Android 为纯 native 应用提供的 Activity 子类，应用只需实现一个 `ANativeActivity_onCreate` C 函数即可。加载流程位于 `src/api-impl-jni/android_app_NativeActivity.c`。

核心的 `loadNativeCode` 函数（第 257-381 行）展示了 ATL 的双路径加载策略：

```c
// src: src/api-impl-jni/android_app_NativeActivity.c:265-293 (简化)
static void *libnb_handle = NULL;
bool (*NativeBridgeIsSupported)(const char *);
void *(*NativeBridgeLoadLibrary)(const char *, int);
void *(*NativeBridgeGetTrampoline)(void *, const char *, const char *, uint32_t);

if (!libnb_handle) {
    libnb_handle = dlopen("libnativebridge.so", RTLD_LAZY);
    NativeBridgeIsSupported = dlsym(libnb_handle, "NativeBridgeIsSupported");
    NativeBridgeLoadLibrary = dlsym(libnb_handle, "NativeBridgeLoadLibrary");
    NativeBridgeGetTrampoline = dlsym(libnb_handle, "NativeBridgeGetTrampoline");
}

bool use_native_bridge = NativeBridgeIsSupported(pathStr);

void *handle;
if (use_native_bridge)
    handle = NativeBridgeLoadLibrary(pathStr, RTLD_LAZY);
else
    handle = bionic_dlopen(pathStr, RTLD_LAZY);
```

两条路径的逻辑：

1. **NativeBridge 路径**：如果应用的 `.so` 文件是为不同架构编译的（例如在 x86_64 主机上运行 ARM 应用），则通过 NativeBridge（如 libhoudini 或 FEX-Emu）进行跨架构翻译加载。
2. **bionic_dlopen 路径**：如果是同架构的 `.so`，则通过 bionic_translation 的 shim 链接器直接加载。

找到入口函数后，调用它启动 native 应用：

```c
// src: src/api-impl-jni/android_app_NativeActivity.c:373
code->createActivityFunc((struct ANativeActivity *)code, rawSavedState, rawSavedSize);
```

`NativeCode` 结构体巧妙地将 `ANativeActivity` 作为第一个成员（偏移量为 0），这样传给应用的 `ANativeActivity*` 指针实际上指向整个 `NativeCode` 结构体，ATL 可以在需要时将其强制转换回来获取额外信息。

---

## 12. bionic_translation 的符号拦截机制（简述）

整个 NDK 重实现能够工作的基础是 bionic_translation 的符号拦截机制。当 Android 应用的 `.so` 调用一个函数（例如 `eglSwapBuffers`）时，bionic_translation 的 shim 链接器 `bionic_dlsym` 会按照三级优先级进行符号解析：

```c
// src: bionic_translation/linker/dlfcn.c:130-158 (简化)
void *bionic_dlsym(void *handle, const char *symbol)
{
    // 第 1 级：查找 bionic_ 前缀版本（ATL 的重实现）
    char wrap_sym_name[1024] = "bionic_";
    memcpy(wrap_sym_name + 7, symbol, strlen(symbol));
    if ((sym = dlsym(RTLD_DEFAULT, wrap_sym_name)))
        return wrapper_create(symbol, sym);     // 找到 bionic_eglSwapBuffers

    // 第 2 级：在 bionic 内部库中查找
    // (soinfo 链表遍历，省略)

    // 第 3 级：宿主系统 dlsym 回退
    if ((sym = dlsym(handle, symbol)))
        return wrapper_create(symbol, sym);     // 直接用宿主版本
}
```

三级解析的意义：

- **第 1 级（bionic_ 前缀）**：ATL 只对需要 ABI 翻译或行为修改的函数提供 `bionic_` 前缀版本。例如 `bionic_eglSwapBuffers` 实现了三缓冲逻辑，`bionic_vkCreateInstance` 注入了平台扩展。
- **第 2 级（内部库查找）**：bionic_translation 加载的 Android .so 之间的符号引用走这条路径。
- **第 3 级（宿主 dlsym）**：对于不需要任何修改的函数（绝大多数 GL/EGL 函数、数学库函数等），直接透传到宿主系统的实现。

这种"只拦截需要修改的，其余全部透传"的设计使得 ATL 不需要重新实现数百个 EGL/GLES 函数，同时又能在关键节点精确插入自己的逻辑。

---

## 小结

回顾 ATL 的 NDK 重实现，我们可以看到几个清晰的设计原则：

1. **最小拦截原则**：只重写必须修改的 API，其余透传。这最大限度地利用了宿主系统的成熟实现。
2. **双后端支持**：ANativeWindow 和 EGL 层同时支持 Wayland 和 X11，确保在各种桌面环境下都能工作。
3. **复用优于重写**：ALooper 直接复用 ART 的 C++ 实现而非从零开始；AAssetManager 委托给 libandroidfw。
4. **优雅降级**：对于传感器、媒体编解码等暂时无法实现的功能，返回安全的错误值让应用自行降级。
5. **跨图形 API 覆盖**：OpenGL ES、Vulkan、甚至 OpenXR 都有对应的翻译层。

全部 10 个源文件加上 3 个头文件，总代码量不到 100KB，却覆盖了绝大多数 native Android 游戏所依赖的系统 API。这种精炼而高效的实现是 ATL 能够以较小团队推进的关键原因之一。

下一篇我们将深入 ART 运行时的独立化：ATL 如何将 AOSP 的 ART 虚拟机从 Android 系统中剥离出来，作为一个独立组件在 Linux 上运行 -- [ART 独立化](atl-04-art-standalone.md)。
