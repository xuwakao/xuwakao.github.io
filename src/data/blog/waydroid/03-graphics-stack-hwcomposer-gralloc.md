---
title: "Waydroid 源码分析（三）：图形栈 — HWComposer 与 Gralloc"
description: "分析 Waydroid 图形栈的实现，包括 HWComposer HAL、Gralloc 内存管理以及与 Wayland 合成器的对接"
pubDatetime: 2021-05-18T00:00:00Z
modDatetime: 2021-05-18T00:00:00Z
author: "xuwakao"
slug: "waydroid-graphics-stack"
tags:
  - android
  - linux
  - waydroid
  - graphics
  - hwcomposer
featured: false
---
# Waydroid 源码分析（三）：图形栈 — HWComposer 与 Gralloc

> 本文深入分析 Waydroid 图形栈的核心实现——HWComposer 如何将 Android SurfaceFlinger 的输出桥接到 Wayland compositor，Gralloc 如何通过 GBM 分配 GPU buffer，以及三种 buffer 传递策略（DMA-buf、android_wlegl、SHM）的实现细节。

## 概述

Waydroid 的图形栈是整个项目中最复杂的部分，也是其"接近原生性能"的核心所在。它需要解决一个关键问题：**如何将 Android 的图形输出（由 SurfaceFlinger 管理）无缝映射到 Linux 的 Wayland 窗口？**

核心源码位于 `android_hardware_waydroid/hwcomposer/` 和 `android_hardware_waydroid/gralloc/`：

| 文件 | 行数 | 职责 |
|------|------|------|
| `hwcomposer/hwcomposer.cpp` | ~950 | HWC HAL 接口实现 |
| `hwcomposer/wayland-hwc.cpp` | ~2095 | Wayland 协议交互 |
| `hwcomposer/wayland-hwc.h` | ~400 | 数据结构定义 |
| `hwcomposer/gralloc_handler.cpp` | ~336 | Buffer 创建策略 |
| `hwcomposer/modes/*.cpp` | ~400 | 显示模式实现 |
| `gralloc/gralloc_gbm.cpp` | ~582 | GBM buffer 分配 |
| `gralloc/gralloc.cpp` | ~331 | Gralloc HAL 接口 |

## 一、图形管线概览

```
Android 应用
    ↓ (Surface)
SurfaceFlinger
    ↓ (hwc_layer_1_t 数组)
┌──────────────────────────────────────────────┐
│ HWComposer HAL (hwcomposer.cpp)              │
│                                              │
│  hwc_prepare()                               │
│    └─ select_mode() → 选择显示模式            │
│         ├─ closed_mode      (无窗口)          │
│         ├─ full_ui_mode     (单窗口全屏)       │
│         ├─ single_window    (单应用窗口)       │
│         └─ multi_window     (多窗口模式)       │
│                                              │
│  hwc_set()                                   │
│    └─ mode->handle_layer()                   │
│         └─ get_wl_buffer()                   │
│              └─ gralloc_handler              │
│                   ├─ create_dmabuf_wl_buffer  │  ← GPU buffer (零拷贝)
│                   ├─ create_android_wl_buffer │  ← native_handle
│                   └─ create_shm_wl_buffer     │  ← CPU buffer (有拷贝)
│                                              │
│  wl_surface_attach() → wl_surface_commit()   │
└──────────────────────────────────────────────┘
    ↓ (Wayland 协议)
宿主机 Wayland Compositor (Mutter/KWin/Sway)
    ↓
宿主机显示器
```

## 二、HWComposer HAL 实现

### HAL 接口

Waydroid 实现的是 `hwc_composer_device_1_t` 接口（HWC 1.x API）。Android 的 SurfaceFlinger 通过这个接口与硬件合成器交互。核心回调函数：

- `hwc_prepare()`: SurfaceFlinger 告诉 HWC "我有这些 layer，你打算怎么合成？"
- `hwc_set()`: SurfaceFlinger 说 "按你的计划合成吧"，HWC 执行实际的图形提交

### 显示模式选择 (select_mode)

`hwcomposer.cpp:135` 中的 `select_mode()` 根据 Android 属性决定显示模式：

```cpp
std::unique_ptr<waydroid_mode> select_mode(
    waydroid_hwc_composer_device_1 *pdev,
    hwc_display_contents_1_t *contents)
{
    std::string active_apps = property_get_string("waydroid.active_apps", "none");

    // 启动动画时强制单窗口模式
    if (active_apps != "Waydroid" && !property_get_bool("waydroid.background_start", true)) {
        for (size_t l = 0; l < contents->numHwLayers; l++) {
            if (pdev->display->layer_names[l].rfind("BootAnimation#", 0) == 0) {
                active_apps = "Waydroid";
                break;
            }
        }
    }

    if (active_apps == "none") {
        return new closed_mode();           // 无窗口
    } else if (active_apps == "Waydroid") {
        return new full_ui_mode();          // 完整 Android UI
    } else if (!pdev->multi_windows) {
        return new single_window_mode();    // 单应用窗口
    } else {
        return new multi_window_mode();     // 多窗口模式
    }
}
```

`waydroid.active_apps` 属性的取值：
- `"none"`: 不显示任何窗口（后台运行）
- `"Waydroid"`: 显示完整 Android 桌面（一个大窗口）
- `"<PackageName>"`: 显示特定应用

`persist.waydroid.multi_windows` 控制是否启用多窗口模式，启用后每个 Android Task 对应一个独立的 Wayland 窗口。

### hwc_prepare()：合成决策

```cpp
static int hwc_prepare(hwc_composer_device_1_t* dev,
                       size_t numDisplays, hwc_display_contents_1_t** displays) {
    auto *pdev = static_cast<waydroid_hwc_composer_device_1 *>(dev);
    hwc_display_contents_1_t *contents = displays[HWC_DISPLAY_PRIMARY];

    // 选择显示模式
    pdev->selected_mode = select_mode(pdev, contents);
    pdev->selected_mode->setup_prepare(pdev, contents);

    for (size_t i = 0; i < contents->numHwLayers; i++) {
        // 光标层始终由 HWC 处理
        if (contents->hwLayers[i].flags & HWC_IS_CURSOR_LAYER) {
            contents->hwLayers[i].compositionType = HWC_OVERLAY;
            continue;
        }
        if (contents->hwLayers[i].compositionType == HWC_FRAMEBUFFER_TARGET)
            continue;

        // 由选定的 mode 决定每个 layer 的合成方式
        pdev->selected_mode->prepare(&contents->hwLayers[i], i);
    }
    return 0;
}
```

`compositionType` 的设置很关键：
- `HWC_OVERLAY`: HWC 直接处理此 layer（零拷贝，最优）
- `HWC_FRAMEBUFFER`: SurfaceFlinger 用 GPU 合成此 layer 到 framebuffer target
- `HWC_FRAMEBUFFER_TARGET`: SurfaceFlinger 合成后的最终结果

在多窗口模式下，每个 layer 都设为 `HWC_OVERLAY`，HWC 直接将每个 layer 映射到对应的 Wayland subsurface，避免了 SurfaceFlinger 的额外合成开销。

### hwc_set()：图形提交

`hwc_set()` 中对每个 layer 调用 `apply_hwc_layer_to_surface_context()`：

```cpp
static int apply_hwc_layer_to_surface_context(
    waydroid_hwc_composer_device_1 *pdev,
    hwc_layer_1 *hwc_layer, size_t hwc_layer_index,
    surface_context &surface_context, buffer *buf = nullptr)
{
    if (!buf) {
        // 1. 获取或创建 Wayland buffer
        buf = get_wl_buffer(pdev, hwc_layer, hwc_layer_index);
    }

    // 2. 等待 acquire fence (GPU 渲染完成)
    if (hwc_layer->acquireFenceFd != -1) {
        sync_wait(hwc_layer->acquireFenceFd, 100 /*ms*/);
    }

    // 3. 将 buffer 附加到 Wayland surface
    surface_context.attach_buffer(*buf);

    // 4. 标记 damage 区域
    apply_surface_damage(hwc_layer, surface_context);

    // 5. 设置变换（旋转/翻转）
    surface_context.set_buffer_transform(
        hwc_transform_to_buffer_transform(hwc_layer->transform));

    // 6. 设置裁剪和缩放
    if (surface_context.viewport) {
        surface_context.set_crop(
            rect_apply_transform(hwc_layer->sourceCropf, hwc_layer->transform));
        surface_context.set_display_frame(hwc_layer->displayFrame, pdev->display->scale);
    } else {
        surface_context.set_buffer_scale(pdev->display->scale);
    }

    // 7. 提交到 Wayland compositor
    wl_surface_commit(surface_context.surface);
    return 0;
}
```

### 多窗口模式：Task ID 到窗口的映射

`modes/multi-window.cpp` 实现了多窗口模式的核心逻辑。每个 Android 图形 layer 的名称中包含 Task ID 信息，HWC 通过解析 layer name 将它们分组到不同的 Wayland 窗口：

```cpp
window *multi_window_mode::get_window(
    waydroid_hwc_composer_device_1 *pdev, layer_info &layer_info)
{
    auto &windows = pdev->display->windows;
    if (layer_info.type == LayerSplitType::TID) {
        // 按 Task ID 分组
        if (is_blacklisted(pdev, layer_info.aid, layer_info.component))
            return nullptr;

        auto it = windows.find(layer_info.tid);
        if (it != windows.end()) {
            return it->second.get();    // 已有窗口
        } else {
            return windows.add(pdev, layer_info.tid, layer_info.aid,
                             layer_info.tid, color_transparent);  // 创建新窗口
        }
    } else if (layer_info.type == LayerSplitType::RawName) {
        // 输入法特殊处理
        if (layer_info.aid == "InputMethod") {
            auto it = windows.find("InputMethod");
            if (it != windows.end()) return it->second.get();
            else return windows.add(pdev, "InputMethod", "InputMethod", "none", color_transparent);
        }
    }
    return nullptr;
}
```

此外，多窗口模式在每帧都会清理已失效的窗口：

```cpp
int multi_window_mode::cleanup_stale_windows(
    waydroid_hwc_composer_device_1* pdev,
    hwc_display_contents_1_t* contents)
{
    pdev->display->windows.erase_if([&](const auto& it) {
        const auto& key = it.first;
        // 检查是否还有 layer 引用此窗口
        for (size_t i = 0; i < contents->numHwLayers; ++i) {
            if (can_handle_layer(contents->hwLayers[i])
                && layer_infos[i].key() == key) {
                return false;  // 仍有引用，保留
            }
        }
        return true;  // 无引用，删除
    });
}
```

### VSync 同步

HWC 维护了一个独立的 vsync 线程，通过 Wayland `wp_presentation` 协议获取精确的帧时序：

```cpp
static void* hwc_vsync_thread(void* data) {
    auto *pdev = static_cast<waydroid_hwc_composer_device_1 *>(data);
    setpriority(PRIO_PROCESS, 0, HAL_PRIORITY_URGENT_DISPLAY);

    while (true) {
        struct timespec wait_time;
        wait_time.tv_nsec = time_to_sleep_to_next_vsync(
            &rt, pdev->last_vsync_ns, pdev->vsync_period_ns);
        nanosleep(&wait_time, NULL);

        if (vsync_enabled && pdev->procs && pdev->procs->vsync) {
            int64_t timestamp = (uint64_t)rt.tv_sec * 1e9 + rt.tv_nsec;
            pdev->procs->vsync(pdev->procs, 0, timestamp);
        }
    }
}
```

`feedback_presented()` 回调从 Wayland compositor 获取实际的 presentation 时间戳，校准 vsync 时机：

```cpp
static void feedback_presented(void *data,
    struct wp_presentation_feedback *feedback,
    uint32_t tv_sec_hi, uint32_t tv_sec_lo, uint32_t tv_nsec, ...)
{
    auto *pdev = static_cast<waydroid_hwc_composer_device_1 *>(data);
    pdev->last_vsync_ns = (((uint64_t)tv_sec_hi << 32) + tv_sec_lo) * 1e9 + tv_nsec;
}
```

---

## 三、Wayland 协议集成

### display 结构体

`wayland-hwc.h` 中的 `display` 结构体是 HWC 与 Wayland 交互的核心状态容器：

```cpp
struct display {
    // Wayland 核心对象
    struct wl_display *display;
    struct wl_registry *registry;
    struct wl_compositor *compositor;
    struct wl_subcompositor *subcompositor;

    // 输入设备
    struct wl_seat *seat;
    struct wl_pointer *pointer;
    struct wl_keyboard *keyboard;
    struct wl_touch *touch;

    // 协议扩展
    struct wp_presentation *presentation;      // 帧时序
    struct wp_viewporter *viewporter;           // 视口缩放
    struct android_wlegl *android_wlegl;        // 自定义 buffer 共享
    struct zwp_linux_dmabuf_v1 *dmabuf;         // DMA-buf 零拷贝
    struct xdg_wm_base *wm_base;               // 窗口管理
    struct zwp_tablet_manager_v2 *tablet_manager;         // 绘图板
    struct zwp_pointer_constraints_v1 *pointer_constraints; // 鼠标锁定
    struct zwp_idle_inhibit_manager_v1 *idle_manager;     // 防息屏
    struct wp_fractional_scale_manager_v1 *fractional_scale_manager; // 分数 DPI

    // GPU 信息
    GrallocType gtype;               // Gralloc 类型
    double scale;                     // 显示缩放比例

    // 输入管道
    int input_fd[INPUT_TOTAL];        // 虚拟输入设备 FD
    int touch_id[MAX_TOUCHPOINTS];    // 触控点映射 (最多 10 点)

    // 窗口管理
    open_windows windows;
    std::recursive_mutex windowsMutex;

    // Buffer 缓存
    std::unordered_map<buffer_handle_t, std::unique_ptr<buffer>> buffer_map;

    // 键盘状态
    std::array<uint8_t, 239> keysDown;

    // 显示尺寸
    int width, height;
    int full_width, full_height;
    int refresh;

    // 支持的格式和 modifier
    std::unordered_set<uint32_t> formats;
    std::map<uint32_t, std::vector<uint64_t>> modifiers;
};
```

### window 结构体

每个 Wayland 窗口由 `window` 结构体表示：

```cpp
struct window {
    struct display *display;

    // XDG 窗口管理
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *xdg_toplevel;

    // 背景 surface
    struct wl_surface *surface;
    struct wp_viewport *viewport;

    // 功能控制
    struct zwp_idle_inhibitor_v1 *idle_inhibitor;
    struct zwp_locked_pointer_v1 *locked_pointer;

    // 子 layer (subsurface)
    std::vector<layer> layers;

    // 窗口标识
    std::string appID;
    std::string taskID;

    std::atomic<bool> configured;
};
```

每个 `window` 可以包含多个 `layer`（实现为 Wayland subsurface），对应 Android 中属于同一 Task 的不同图形层。

### 输入事件

HWC 接收 Wayland 输入事件，通过命名管道传递给 Android 的 InputFlinger：

```cpp
static const char *INPUT_PIPE_NAME[INPUT_TOTAL] = {
    "/dev/input/wl_touch_events",      // 触摸
    "/dev/input/wl_keyboard_events",   // 键盘
    "/dev/input/wl_pointer_events",    // 鼠标
    "/dev/input/wl_tablet_events"      // 绘图板
};
```

这些管道在容器内作为虚拟输入设备出现，Android 的 InputFlinger 从中读取事件。

---

## 四、Buffer 传递策略

### gralloc_handler：策略模式

`gralloc_handler.cpp` 使用策略模式，根据 Gralloc 类型和 Wayland compositor 能力选择最优的 buffer 传递方式：

```cpp
gralloc_handler::gralloc_handler(display *display)
    : get_buffer_metadata_impl(select_get_buffer_metadata_impl(display->gtype))
    , create_buffer_impl(select_create_buffer_impl(display, display->gtype))
    , update_shm_buffer_impl(select_update_shm_buffer_impl(display->gtype))
{ }
```

选择逻辑：

```cpp
gralloc_handler::create_buffer_func
gralloc_handler::select_create_buffer_impl(display *display, GrallocType gralloc_type) {
    if (gralloc_type == GrallocType::GRALLOC_GBM && display->dmabuf) {
        return create_buffer_gbm;       // GBM + DMA-buf 支持 → 零拷贝
    } else if (gralloc_type == GrallocType::GRALLOC_CROS && display->dmabuf) {
        return create_buffer_cros;      // ChromeOS gralloc + DMA-buf
    } else if (gralloc_type == GrallocType::GRALLOC_ANDROID && display->android_wlegl) {
        return create_buffer_android;   // 自定义协议
    } else {
        return create_buffer_generic;   // 回退到 SHM (最慢)
    }
}
```

优先级：**DMA-buf > android_wlegl > SHM**

### 策略一：DMA-buf（零拷贝，最优）

DMA-buf 是 Linux 的统一 buffer 共享框架。GPU 分配的 buffer 可以直接通过文件描述符（prime_fd）传递给 Wayland compositor，无需任何数据拷贝。

**GBM Gralloc 路径** (`create_buffer_gbm`):

```cpp
std::unique_ptr<buffer> create_buffer_gbm(display *display,
    const buffer_metadata& metadata, buffer_handle_t handle)
{
    auto *drm_handle = reinterpret_cast<const gralloc_handle_t *>(handle);
    return create_dmabuf_wl_buffer(display, metadata,
        drm_handle->prime_fd,      // GPU buffer 的 DMA-buf FD
        -1,                        // 自动转换 DRM 格式
        drm_handle->stride,
        0,                         // offset
        drm_handle->modifier,      // DRM format modifier
        handle);
}
```

**DMA-buf Wayland buffer 创建** (`create_dmabuf_wl_buffer`):

```cpp
std::unique_ptr<buffer> create_dmabuf_wl_buffer(display *display,
    const buffer_metadata& metadata, int prime_fd, int drm_format,
    int byte_stride, int offset, uint64_t modifier, buffer_handle_t handle)
{
    auto buf = std::make_unique<buffer>();
    buf->metadata = metadata;
    buf->handle = handle;

    if (drm_format < 0) {
        drm_format = ConvertHalFormatToDrm(display, metadata.format);
    }

    // 使用 zwp_linux_dmabuf_v1 协议
    zwp_linux_buffer_params_v1 *params =
        zwp_linux_dmabuf_v1_create_params(display->dmabuf);
    zwp_linux_buffer_params_v1_add(params, prime_fd, 0, offset,
        byte_stride, modifier >> 32, modifier & 0xffffffff);

    // 立即创建 wl_buffer（同步方式）
    buf->wl_buffer = zwp_linux_buffer_params_v1_create_immed(params,
        metadata.width, metadata.height, drm_format, 0);

    return buf;
}
```

**格式转换**是 DMA-buf 路径中的一个关键细节。Android HAL 格式与 DRM fourcc 格式不同：

```cpp
uint32_t ConvertHalFormatToDrm(display *display, uint32_t hal_format) {
    switch (hal_format) {
        case HAL_PIXEL_FORMAT_RGBA_8888:
            fmt = DRM_FORMAT_ABGR8888;
            if (!isFormatSupported(display, fmt))
                fmt = DRM_FORMAT_ARGB8888;    // 回退
            break;
        case HAL_PIXEL_FORMAT_RGBX_8888:
            fmt = DRM_FORMAT_XBGR8888;
            if (!isFormatSupported(display, fmt))
                fmt = DRM_FORMAT_XRGB8888;
            break;
        case HAL_PIXEL_FORMAT_YV12:
            fmt = DRM_FORMAT_YVU420;
            if (!isFormatSupported(display, fmt))
                fmt = DRM_FORMAT_GR88;        // planar 格式 workaround
            break;
        // ...
    }
    // 最终验证 compositor 是否支持此格式
    if (!isFormatSupported(display, fmt)) {
        ALOGE("Current wayland display doesn't support hal format %u", hal_format);
        return -EINVAL;
    }
}
```

注意 `isFormatSupported()` 检查——不同的 Wayland compositor 支持的 DRM 格式集合不同，HWC 会先查询 compositor 支持的格式列表（通过 `zwp_linux_dmabuf_v1` 协议的 format 事件），然后选择双方都支持的格式。

### 策略二：android_wlegl（自定义协议）

当 Gralloc 为 `GRALLOC_ANDROID` 类型（HALIUM 环境）时，使用 Waydroid 自定义的 `android_wlegl` Wayland 协议：

```cpp
std::unique_ptr<buffer> create_android_wl_buffer(display *display,
    const buffer_metadata& metadata, buffer_handle_t handle)
{
    auto buf = std::make_unique<buffer>();
    buf->metadata = metadata;
    buf->handle = handle;

    // 1. 打包 native_handle 的整数部分
    struct wl_array ints;
    wl_array_init(&ints);
    int *the_ints = (int *)wl_array_add(&ints, handle->numInts * sizeof(int));
    memcpy(the_ints, handle->data + handle->numFds, handle->numInts * sizeof(int));

    // 2. 创建 wlegl handle
    android_wlegl_handle *wlegl_handle =
        android_wlegl_create_handle(display->android_wlegl, handle->numFds, &ints);
    wl_array_release(&ints);

    // 3. 逐个传递文件描述符
    for (int i = 0; i < handle->numFds; i++) {
        android_wlegl_handle_add_fd(wlegl_handle, handle->data[i]);
    }

    // 4. 创建 wl_buffer
    buf->wl_buffer = android_wlegl_create_buffer(display->android_wlegl,
        metadata.width, metadata.height, metadata.pixel_stride,
        metadata.format, GRALLOC_USAGE_HW_RENDER, wlegl_handle);
    android_wlegl_handle_destroy(wlegl_handle);

    return buf;
}
```

这个协议的核心是传递 Android 的 `native_handle_t`——一个包含文件描述符（FD）和整数数据的不透明结构。FD 通过 Wayland 协议的 FD 传递机制（Unix domain socket 的 `SCM_RIGHTS`）发送。

### 策略三：SHM（共享内存，回退方案）

当既没有 DMA-buf 也没有 android_wlegl 支持时，使用 SHM（共享内存）。这是唯一需要数据拷贝的方案：

```cpp
std::unique_ptr<buffer> create_shm_wl_buffer(display *display,
    const buffer_metadata& metadata, buffer_handle_t handle)
{
    auto buf = std::make_unique<buffer>();
    int shm_stride = metadata.width * 4;  // 假设 4bpp
    int size = shm_stride * metadata.height;

    buf->isShm = true;
    buf->size = size;

    // 1. 创建 memfd (匿名内存文件)
    int fd = syscall(SYS_memfd_create, "buffer", MFD_ALLOW_SEALING);
    ftruncate(fd, size);

    // 2. mmap 映射
    buf->shm_data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);

    // 3. 创建 Wayland SHM pool 和 buffer
    auto shm_format = ConvertHalFormatToShm(metadata.format);
    struct wl_shm_pool *pool = wl_shm_create_pool(display->shm, fd, size);
    buf->wl_buffer = wl_shm_pool_create_buffer(pool, 0,
        metadata.width, metadata.height, shm_stride, shm_format);
    wl_shm_pool_destroy(pool);
    close(fd);

    return buf;
}
```

SHM buffer 创建后，每帧都需要更新内容。有两种 SHM 更新策略：

**策略 A：EGL 渲染到像素**（非 default gralloc）

```cpp
void update_shm_buffer_generic(display *display, buffer *buffer) {
    display->egl_work_queue.emplace_back(
        std::bind(egl_render_to_pixels, display, buffer));
    sem_post(&display->egl_go);
    sem_wait(&display->egl_done);
}
```

通过 EGL worker 线程将 GPU buffer 的内容渲染到 SHM 区域。

**策略 B：直接像素拷贝 + 颜色通道转换**（default gralloc）

```cpp
void update_shm_buffer_default(display *, buffer *buffer) {
    void *data;
    android::Rect bounds(buffer->metadata.width, buffer->metadata.height);
    if (GraphicBufferMapper::get().lock(buffer->handle,
            GRALLOC_USAGE_SW_READ_OFTEN, bounds, &data) == 0) {
        for (int i = 0; i < buffer->metadata.height; i++) {
            uint32_t* source = (uint32_t*)data + (i * src_stride);
            uint32_t* dist = (uint32_t*)buffer->shm_data + (i * shm_stride);
            while (dist < end) {
                uint32_t c = *source;
                // RGBA → ARGB 颜色通道转换
                *dist = (c & 0xFF00FF00)
                      | ((c & 0xFF0000) >> 16)
                      | ((c & 0xFF) << 16);
                source++;
                dist++;
            }
        }
        GraphicBufferMapper::get().unlock(buffer->handle);
    }
}
```

注意逐像素的颜色通道转换 `(c & 0xFF00FF00) | ((c & 0xFF0000) >> 16) | ((c & 0xFF) << 16)`——这将 Android 的 RGBA 格式转换为 Wayland SHM 使用的 ARGB 格式（R 和 B 通道交换）。

### Buffer 缓存

HWC 维护了一个 buffer 缓存，避免重复创建：

```cpp
buffer *find_cached_buffer(waydroid_hwc_composer_device_1 *pdev,
    const buffer_metadata &metadata, buffer_handle_t handle)
{
    auto it = pdev->display->buffer_map.find(handle);
    if (it != pdev->display->buffer_map.end()) {
        // 检查 metadata 是否匹配（handle 可能被复用）
        if (it->second->metadata != metadata) {
            pdev->display->buffer_map.erase(it);  // 不匹配，删除缓存
        } else {
            return it->second.get();  // 命中缓存
        }
    }
    return nullptr;
}
```

注释中提到了一个重要的边界情况：`buffer_handle_t` 可能被 Android 回收并分配给新 buffer，导致缓存的 handle 对应已销毁的旧 buffer。通过额外检查 metadata（宽高、stride、格式）来降低这种风险。

---

## 五、Gralloc GBM 实现

### 概述

`gralloc/gralloc_gbm.cpp` 实现了 Android Gralloc HAL，使用 Linux 的 GBM（Generic Buffer Management）API 分配 GPU buffer。

### DRM Format Modifier 支持

现代 GPU 使用 tiled 或 compressed 的内存布局来提升性能。DRM format modifier 描述了这些非线性布局：

```cpp
static std::vector<uint64_t> get_supported_modifiers(
    struct gbm_device *gbm, uint32_t format)
{
    if (gbm_format_modifiers_map.find(format) != gbm_format_modifiers_map.end())
        return gbm_format_modifiers_map[format];

    std::vector<uint64_t> &modifiers = gbm_format_modifiers_map[format];

    // 从 Android 属性读取 modifier 列表
    // 格式: waydroid.modifiers.<hex_format>.<index> = <hex_modifier>
    std::string prop_name_base = "waydroid.modifiers." + hex(format) + ".";
    int i = 0;
    while (true) {
        std::string prop_name = prop_name_base + std::to_string(i);
        if (property_get(prop_name.c_str(), modifier_prop, NULL) < 1)
            break;

        uint64_t mod = parse_hex(modifier_prop);

        // 过滤多平面 modifier（仅支持单平面）
        if (gbm_device_get_format_modifier_plane_count(gbm, format, mod) < 2) {
            modifiers.push_back(mod);
        }
        i++;
    }
    return modifiers;
}
```

HWComposer 在初始化时查询 Wayland compositor 支持的 modifier，并通过 Android 属性传递给 Gralloc。Gralloc 分配 buffer 时使用这些 modifier：

```cpp
// 如果有 modifier 支持
if (!modifiers.empty()) {
    bo = gbm_bo_create_with_modifiers2(gbm, width, height,
        format, modifiers.data(), modifiers.size(), usage);
}
// 回退到基本创建
if (!bo) {
    bo = gbm_bo_create(gbm, width, height, format, usage);
}
```

`gbm_bo_create_with_modifiers2()` 让 GBM 驱动选择最优的内存布局。

---

## 六、Surface Damage 优化

HWC 通过 Wayland 的 surface damage 机制告诉 compositor 哪些区域发生了变化，避免 compositor 重新合成整个窗口：

```cpp
static void apply_surface_damage(hwc_layer_1 *hwc_layer,
    surface_context &surface_context)
{
    auto &surface_damage = hwc_layer->surfaceDamage;

    if (surface_damage.numRects == 0 || /* 协议版本不支持 */) {
        // 全区域 damage
        surface_context.damage_surface(0, 0, INT32_MAX, INT32_MAX);
        return;
    }

    // 精确 damage：只标记实际变化的区域
    std::for_each(surface_damage.rects,
        surface_damage.rects + surface_damage.numRects,
        [&](const auto &rect) {
            surface_context.damage_surface(
                rect.left, rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top);
        });
}
```

---

## 七、应用黑名单

某些 Android 应用在多窗口模式下表现异常。HWC 维护了一个黑名单：

```cpp
bool is_blacklisted(waydroid_hwc_composer_device_1* pdev,
    const std::string &app_id, const std::string &component) {
    auto match = pdev->blacklisted_apps.find(app_id);
    if (match == pdev->blacklisted_apps.end())
        return false;
    auto &components = match->second;
    // 空 components 列表 = 整个 app 被黑名单
    // 非空 = 只有特定 component 被黑名单
    return components.empty() ||
        std::find(components.begin(), components.end(), component) != components.end();
}
```

被黑名单的应用不会创建独立的 Wayland 窗口，其 layer 会被忽略。

---

## 总结

Waydroid 的图形栈通过几个关键设计实现了高效的 Android→Wayland 图形桥接：

1. **策略模式的 Buffer 传递**: DMA-buf 零拷贝作为首选，SHM 作为通用回退
2. **多窗口模式**: 解析 Android Task ID，将 layer 分组到独立 Wayland 窗口
3. **Subsurface 层叠**: 同一 Task 的多个 layer 使用 Wayland subsurface，保持 z-order
4. **Format Modifier 协商**: Gralloc 与 Wayland compositor 协商最优内存布局
5. **Buffer 缓存**: 避免每帧重复创建 wl_buffer
6. **VSync 校准**: 通过 `wp_presentation` 获取 compositor 实际帧时序

其主要权衡是：**以 HWC 1.x API 的限制（不支持 Fence-based explicit sync）换取实现简单性和广泛兼容性**。

---

## 下一篇预告

在下一篇文章中，我们将分析 **会话管理与桌面集成**——包括 Android 应用如何出现在 Linux 桌面的应用菜单中、剪贴板如何在两个系统间同步、以及 Android 通知如何桥接到 freedesktop 通知系统。

---

*本文基于 [Waydroid](https://github.com/waydroid) 项目源码分析。*
