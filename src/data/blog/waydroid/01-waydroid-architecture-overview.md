---
title: "Waydroid 源码分析（一）：整体架构与设计哲学"
description: "从源码层面分析 Waydroid 的整体架构设计，揭示如何在 Linux 桌面上通过容器化方案运行完整 Android 系统"
pubDatetime: 2021-05-02T00:00:00Z
modDatetime: 2021-05-02T00:00:00Z
author: "xuwakao"
slug: "waydroid-architecture-overview"
tags:
  - android
  - linux
  - waydroid
  - container
  - architecture
featured: false
---
# Waydroid 源码分析（一）：整体架构与设计哲学

> 本文基于 Waydroid v1.6.2 源码，深入分析其架构设计与核心原理。

## 前置知识

在深入 Waydroid 之前，我们需要理解几个关键的技术背景。

### Linux 容器与 LXC

**Linux 容器（Linux Containers）** 是一种操作系统级虚拟化技术。与传统虚拟机不同，容器不需要运行独立的内核——所有容器共享宿主机的 Linux 内核，但各自拥有隔离的用户空间。

**LXC（Linux Containers）** 是 Linux 容器技术的一个早期且底层的实现。与 Docker 面向应用容器不同，LXC 更接近"轻量级虚拟机"的定位——它能运行一个完整的 Linux 发行版（或者在 Waydroid 的场景下，一个完整的 Android 系统）。

LXC 的核心依赖两个 Linux 内核特性：

#### Linux Namespaces（命名空间）

Namespaces 提供了资源隔离。每种 namespace 隔离一类系统资源：

| Namespace | 隔离内容 | 在 Waydroid 中的作用 |
|-----------|----------|---------------------|
| **PID** | 进程 ID 空间 | 容器内 Android 的 `/init` 进程 PID=1，与宿主进程树隔离 |
| **NET** | 网络栈 | 容器获得独立的 `eth0` 网卡，通过 veth pair 连接到宿主机网桥 |
| **MNT** | 挂载点 | 容器看到的是 Android rootfs，而非宿主机文件系统 |
| **UTS** | 主机名 | 容器拥有独立的主机名（`waydroid`） |
| **IPC** | 进程间通信 | System V IPC、POSIX 消息队列隔离 |

Waydroid 的 LXC 配置（`data/configs/config_3`）可以看到 UTS namespace 的使用：

```
lxc.uts.name = waydroid
```

#### Cgroups（控制组）

Cgroups 提供资源限制。LXC 通过 cgroups 控制容器可使用的 CPU、内存等资源。在 Waydroid 的 LXC 配置中：

```
lxc.mount.auto = cgroup:ro sys:ro proc
```

容器以只读方式挂载 cgroup 和 sys 文件系统，防止容器内进程修改宿主机的 cgroup 配置。

### 容器 vs 虚拟化：为什么 Waydroid 选择容器？

传统运行 Android 的方案通常基于虚拟化（如 QEMU/KVM）：

```
┌─────────────────────────────────┐
│    虚拟化方案 (QEMU/KVM)         │
│                                 │
│  宿主机 Linux 内核               │
│       ↓ KVM 硬件虚拟化            │
│  虚拟机内核 (Android Linux)       │
│       ↓                         │
│  Android 用户空间                │
│                                 │
│  GPU: virtio-gpu (软件模拟)      │
│  性能开销: 显著                   │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│    容器方案 (Waydroid/LXC)       │
│                                 │
│  宿主机 Linux 内核 ← 共享!       │
│       ↓ namespace 隔离           │
│  Android 用户空间                │
│                                 │
│  GPU: 直接访问宿主机 GPU          │
│  性能开销: 极小                   │
└─────────────────────────────────┘
```

| 对比维度 | 虚拟化 (QEMU/KVM) | 容器 (LXC/Waydroid) |
|----------|-------------------|---------------------|
| 内核 | 独立的虚拟机内核 | 共享宿主机内核 |
| GPU | virtio-gpu 模拟，性能损失大 | 直接 passthrough，接近原生性能 |
| 启动时间 | 较慢（需引导内核） | 快（直接启动 `/init`） |
| 内存开销 | 需预分配虚拟机内存 | 共享宿主机内存 |
| 隔离性 | 强（硬件级隔离） | 弱（共享内核，namespace 隔离） |
| 内核依赖 | 无特殊要求 | 需要 binder/ashmem 等内核模块 |

Waydroid 选择容器方案的核心理由是**性能**——特别是 GPU 直通带来的图形性能优势。但代价是对宿主内核有硬性要求。

### Android Binder IPC

Android 系统高度依赖 **Binder** 作为进程间通信机制。Binder 是一个 Linux 内核驱动，它提供了高效的跨进程方法调用能力。Android 使用三个 Binder 设备：

| 设备节点 | 用途 |
|----------|------|
| `/dev/binder` | Framework 层 IPC（Activity Manager、Package Manager 等） |
| `/dev/vndbinder` | Vendor 进程间 IPC |
| `/dev/hwbinder` | HAL（硬件抽象层）通信 |

Binder 并非标准 Linux 内核的一部分（虽然已被合入 staging 目录）。Waydroid 需要宿主内核加载 `binder_linux` 模块。从源码（`tools/helpers/drivers.py`）可以看到，Waydroid 支持多种 binder 设备名称以避免与其他 Android 容器方案冲突：

```python
BINDER_DRIVERS = [
    "anbox-binder",
    "puddlejumper",
    "bonder",
    "binder"
]
```

如果内核支持 binderfs，Waydroid 会通过 ioctl 动态分配设备节点：

```python
BINDER_CTL_ADD = IOWR(98, 1, 264)
binderctrlfd = open('/dev/binderfs/binder-control','rb')
for node in binder_dev_nodes:
    node_struct = struct.pack('256sII', bytes(node, 'utf-8'), 0, 0)
    fcntl.ioctl(binderctrlfd.fileno(), BINDER_CTL_ADD, node_struct)
```

### Ashmem（Anonymous Shared Memory）

Ashmem 是 Android 的匿名共享内存机制，用于在进程间高效共享大块数据（如图形 buffer）。Waydroid 在初始化时尝试加载 `ashmem_linux` 模块：

```python
def probeAshmemDriver(args):
    if not os.path.exists("/dev/ashmem"):
        command = ["modprobe", "-q", "ashmem_linux"]
        tools.helpers.run.user(args, command, check=False)
```

如果 ashmem 不可用，Waydroid 会设置属性 `sys.use_memfd=true`，让 Android 回退到标准 Linux 的 memfd 机制。

### Wayland 显示协议

**Wayland** 是 Linux 上的下一代显示协议，取代老旧的 X11。Wayland 的核心概念：

- **Compositor（合成器）**: 负责窗口管理和最终渲染（如 GNOME 的 Mutter、KDE 的 KWin）
- **Client**: 通过 Wayland 协议与 Compositor 通信，提交图形 buffer
- **Surface**: 一个可显示的矩形区域，client 向 surface 提交内容

Waydroid 的 HWComposer HAL 充当 Wayland client 的角色——它从 Android SurfaceFlinger 接收合成后的图形 buffer，然后作为 Wayland surface 提交给宿主机的 Wayland compositor。

---

## Waydroid 整体架构

理解了上述背景知识后，我们来看 Waydroid 的整体架构。

### 三层架构

Waydroid 的代码库分为三个仓库，对应三个架构层：

```
┌─────────────────────────────────────────────────────┐
│                   宿主机 Linux                        │
│                                                     │
│  ┌───────────────────────────────────────────┐      │
│  │  waydroid/ (Python 管理工具)                │      │
│  │  - CLI 命令路由                            │      │
│  │  - D-Bus 系统服务 (id.waydro.Container)    │      │
│  │  - LXC 容器生命周期管理                     │      │
│  │  - 镜像下载与 OverlayFS 挂载               │      │
│  │  - 会话管理与桌面集成                       │      │
│  └───────────┬───────────────────────────────┘      │
│              │ 管理                                  │
│  ┌───────────▼───────────────────────────────┐      │
│  │           LXC 容器 (Android)               │      │
│  │                                           │      │
│  │  ┌─────────────────────────────────────┐  │      │
│  │  │ android_hardware_waydroid/ (HAL 层)  │  │      │
│  │  │ - HWComposer: Wayland 显示桥接       │  │      │
│  │  │ - Gralloc: GPU buffer 分配 (GBM)     │  │      │
│  │  │ - Audio: ALSA/TinyALSA 音频桥接      │  │      │
│  │  │ - Sensors/Power/Lights: Stub 实现    │  │      │
│  │  └─────────────────────────────────────┘  │      │
│  │                                           │      │
│  │  ┌─────────────────────────────────────┐  │      │
│  │  │ android_vendor_waydroid/ (Vendor 层) │  │      │
│  │  │ - init.waydroid.rc: 服务启动配置      │  │      │
│  │  │ - SEPolicy: 安全策略                  │  │      │
│  │  │ - 补丁管理: Framework 修改            │  │      │
│  │  │ - hosthals.xml: HAL 重定向声明        │  │      │
│  │  └─────────────────────────────────────┘  │      │
│  │                                           │      │
│  │  Android Framework (LineageOS)            │      │
│  │  └─ SurfaceFlinger, ActivityManager, ...  │      │
│  └───────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────┘
```

### 入口与命令路由

Waydroid 的入口极为简洁。`waydroid.py` 仅有 11 行：

```python
# waydroid.py
import os, sys, tools

if __name__ == "__main__":
    os.umask(0o0022)
    sys.exit(tools.main())
```

所有逻辑在 `tools/__init__.py` 的 `main()` 函数中展开。它通过 argparse 解析命令，然后路由到对应的 action 模块：

```python
# tools/__init__.py - main() 核心路由逻辑
def main():
    args = helpers.arguments()
    prep_args(args)

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    dbus.mainloop.glib.threads_init()

    if args.action == "init":
        actions.init(args)                          # 初始化
    elif args.action == "session":
        actions.session_manager.start(args)         # 会话管理
    elif args.action == "container":
        actions.container_manager.start(args)       # 容器管理
    elif args.action == "app":
        actions.app_manager.install/launch(args)    # 应用管理
    elif args.action == "shell":
        helpers.lxc.shell(args)                     # 直接进入容器 shell
    # ... 更多命令
```

`prep_args` 设置了关键的全局路径：

```python
def prep_args(args):
    args.work = "/var/lib/waydroid"           # 工作目录
    args.config = args.work + "/waydroid.cfg" # 配置文件
    args.log = args.work + "/waydroid.log"    # 日志文件
```

### 初始化流程

`waydroid init` 是使用 Waydroid 的第一步。从 `tools/actions/initializer.py` 可以追踪完整的初始化流程：

```
waydroid init
    │
    ├─ 1. setup_config(args)
    │     ├─ 检测 CPU 架构 (arm64/x86_64)
    │     ├─ 判断 vendor 类型 (MAINLINE vs HALIUM)
    │     ├─ 分配 binder 设备节点
    │     └─ 配置 OTA 下载通道
    │
    ├─ 2. helpers.images.get(args)
    │     ├─ 从 ota.waydro.id 下载 system.img + vendor.img
    │     ├─ SHA256 校验
    │     └─ 解压到 /var/lib/waydroid/images/
    │
    ├─ 3. 创建 overlay 目录结构
    │     ├─ /var/lib/waydroid/overlay/
    │     ├─ /var/lib/waydroid/overlay_rw/system/
    │     └─ /var/lib/waydroid/overlay_rw/vendor/
    │
    ├─ 4. helpers.lxc.set_lxc_config(args)
    │     ├─ 拼接 LXC 配置文件 (config_base + config_3 + config_4)
    │     ├─ 生成设备节点挂载配置 (config_nodes)
    │     └─ 配置 seccomp 和 AppArmor
    │
    └─ 5. helpers.lxc.make_base_props(args)
          ├─ 检测 gralloc HAL (GBM/mesa/swiftshader)
          ├─ 检测 EGL/Vulkan 实现
          ├─ 检测 DRI 渲染节点
          └─ 生成 waydroid_base.prop
```

**Vendor 类型判断** 是初始化中的一个有趣设计。Waydroid 支持两种运行环境：

```python
def get_vendor_type(args):
    vndk_str = helpers.props.host_get(args, "ro.vndk.version")
    ret = "MAINLINE"
    if vndk_str != "":
        vndk = int(vndk_str)
        if vndk > 19:
            halium_ver = vndk - 19
            ret = "HALIUM_" + str(halium_ver)
    return ret
```

- **MAINLINE**: 标准 Linux 桌面（Ubuntu、Fedora、Arch 等）。需要自行加载 binder/ashmem 模块。
- **HALIUM**: Ubuntu Touch 等基于 Halium 的系统。宿主机已有 Android HAL 层，直接使用宿主机的 binder 设备。

### 容器启动流程

当用户执行 `waydroid session start` 时，会触发一个双层启动过程：

**第一层：D-Bus 系统服务（root 权限）**

`waydroid container start` 启动一个 D-Bus 系统服务 `id.waydro.Container`，暴露 `ContainerManager` 接口：

```python
class DbusContainerManager(dbus.service.Object):
    @dbus.service.method("id.waydro.ContainerManager",
                         in_signature='a{ss}', out_signature='')
    def Start(self, session, sender, conn):
        # 验证调用者身份
        uid = dbus_info.GetConnectionUnixUser(sender)
        if str(uid) not in ["0", session["user_id"]]:
            raise RuntimeError("Cannot start a session on behalf of another user")
        do_start(self.args, session)
```

`do_start()` 是容器启动的核心函数（`container_manager.py:153`），执行以下步骤：

```python
def do_start(args, session):
    # 1. 加载内核驱动（仅首次）
    prepare_drivers_once(args)

    # 2. 启动网络
    command = [tools.config.tools_src + "/data/scripts/waydroid-net.sh", "start"]
    tools.helpers.run.user(args, command)

    # 3. 启动传感器守护进程
    if which("waydroid-sensord"):
        tools.helpers.run.user(args, ["waydroid-sensord", "/dev/" + args.HWBINDER_DRIVER],
                               output="background")

    # 4. 设置设备权限 (DRI, framebuffer, video 等)
    set_permissions(args)

    # 5. 生成会话级 LXC 配置 (Wayland/PulseAudio socket 绑定)
    helpers.lxc.generate_session_lxc_config(args, session)

    # 6. 挂载 rootfs (OverlayFS)
    helpers.images.mount_rootfs(args, cfg["waydroid"]["images_path"], session)

    # 7. 启动 LXC 容器
    helpers.lxc.start(args)  # → lxc-start -F -n waydroid -- /init

    # 8. 启动硬件服务
    services.hardware_manager.start(args)
```

**第二层：用户会话（用户权限）**

Session 在用户空间运行，通过 Session D-Bus 与容器通信，启动桌面集成服务（下文详述）。

### LXC 配置详解

Waydroid 的 LXC 配置由多个片段拼接而成。核心基础配置（`data/configs/config_base`）：

```ini
# Rootfs 路径
lxc.rootfs.path = /var/lib/waydroid/rootfs
lxc.arch = LXCARCH         # 运行时替换为实际架构
lxc.autodev = 0            # 不自动创建 /dev

# 保留的 Linux capabilities（安全白名单）
lxc.cap.keep = audit_control sys_nice wake_alarm setpcap setgid setuid
               sys_ptrace sys_admin wake_alarm block_suspend sys_time
               net_admin net_raw net_bind_service kill dac_override
               dac_read_search fsetid mknod syslog chown sys_resource
               fowner ipc_lock sys_chroot

# 自动挂载
lxc.mount.auto = cgroup:ro sys:ro proc

# 包含动态生成的配置
lxc.include = /var/lib/waydroid/lxc/waydroid/config_nodes    # 设备节点
lxc.include = /var/lib/waydroid/lxc/waydroid/config_session  # 会话绑定
```

网络配置（`config_3`）：

```ini
lxc.uts.name = waydroid

# 安全配置
lxc.apparmor.profile = unconfined    # AppArmor 配置（可被替换为 lxc-waydroid）
lxc.seccomp.profile = /var/lib/waydroid/lxc/waydroid/waydroid.seccomp
lxc.no_new_privs = 1                # 禁止提权

# 网络: veth pair 连接到 waydroid0 网桥
lxc.net.0.type = veth
lxc.net.0.flags = up
lxc.net.0.link = waydroid0
lxc.net.0.name = eth0
lxc.net.0.hwaddr = 00:16:3e:f9:d3:03
lxc.net.0.mtu = 1500
```

### 设备节点透传

`generate_nodes_lxc_config()`（`tools/helpers/lxc.py:38`）动态生成容器可访问的设备节点列表。这是 Waydroid "直接硬件访问"理念的核心实现：

```python
def generate_nodes_lxc_config(args):
    nodes = []

    # 基础设备
    make_entry("/dev/zero")
    make_entry("/dev/null")
    make_entry("/dev/ashmem")
    make_entry("/dev/fuse")
    make_entry("/dev/ion")

    # GPU 设备 — 关键: 直接 passthrough
    make_entry("/dev/kgsl-3d0")      # Qualcomm GPU
    make_entry("/dev/mali0")          # ARM Mali GPU
    make_entry("/dev/dxg")            # NVIDIA (WSL)
    render, _ = tools.helpers.gpu.getDriNode(args)
    make_entry(render)                # DRI 渲染节点 (e.g., /dev/dri/renderD128)

    for n in glob.glob("/dev/fb*"):   # 帧缓冲
        make_entry(n)
    for n in glob.glob("/dev/video*"):  # 摄像头
        make_entry(n)
    for n in glob.glob("/dev/dma_heap/*"):  # DMA-BUF 堆
        make_entry(n)

    # Binder 设备 — 容器内映射为标准名称
    make_entry("/dev/" + args.BINDER_DRIVER, "dev/binder")
    make_entry("/dev/" + args.VNDBINDER_DRIVER, "dev/vndbinder")
    make_entry("/dev/" + args.HWBINDER_DRIVER, "dev/hwbinder")

    # VPN 支持
    make_entry("/dev/net/tun", "dev/tun")
```

注意 Binder 设备的映射：宿主机上可能叫 `anbox-binder`（避免与其他方案冲突），但在容器内统一映射为标准的 `/dev/binder`。

### OverlayFS 镜像挂载

Waydroid 使用 OverlayFS 实现系统镜像的分层管理。`mount_rootfs()`（`tools/helpers/images.py:166`）展示了完整的挂载过程：

```python
def mount_rootfs(args, images_dir, session):
    # 第一层: 挂载 system.img 为只读基础
    helpers.mount.mount(args, images_dir + "/system.img",
                        tools.config.defaults["rootfs"], umount=True)

    # 第二层: OverlayFS 叠加可写层
    if cfg["waydroid"]["mount_overlays"] == "True":
        helpers.mount.mount_overlay(args,
            [defaults["overlay"], defaults["rootfs"]],      # lower (只读)
            defaults["rootfs"],                              # merged (最终视图)
            upper_dir=defaults["overlay_rw"] + "/system",    # upper (可写)
            work_dir=defaults["overlay_work"] + "/system")   # work (OverlayFS 内部)

    # 第三层: 挂载 vendor.img
    helpers.mount.mount(args, images_dir + "/vendor.img",
                        defaults["rootfs"] + "/vendor")
    # vendor 同样有 overlay

    # 第四层: 绑定宿主机的 EGL 库
    for egl_path in ["/vendor/lib/egl", "/vendor/lib64/egl"]:
        if os.path.isdir(egl_path):
            helpers.mount.bind(args, egl_path, defaults["rootfs"] + egl_path)

    # 第五层: 生成并挂载属性文件
    make_prop(args, session, args.work + "/waydroid.prop")
    helpers.mount.bind_file(args, args.work + "/waydroid.prop",
                            defaults["rootfs"] + "/vendor/waydroid.prop")
```

挂载层次如下：

```
最终 rootfs 视图 (/var/lib/waydroid/rootfs)
    │
    ├─ OverlayFS merged
    │   ├─ upper: /var/lib/waydroid/overlay_rw/system  (可写，持久化用户修改)
    │   └─ lower: /var/lib/waydroid/overlay + system.img (只读)
    │
    ├─ /vendor (OverlayFS merged)
    │   ├─ upper: overlay_rw/vendor
    │   └─ lower: overlay/vendor + vendor.img
    │
    ├─ /vendor/lib/egl  → 绑定挂载到宿主机 EGL 库
    ├─ /vendor/lib64/egl → 绑定挂载到宿主机 EGL 库
    ├─ /odm_extra       → 绑定挂载到宿主机 /odm 或 /vendor/odm
    └─ /vendor/waydroid.prop → 运行时属性文件
```

这个设计有几个优点：
1. **系统镜像不可变**: OTA 升级时只需替换 img 文件
2. **用户修改持久化**: 安装的应用、修改的设置写入 overlay_rw
3. **恢复出厂**: 只需删除 overlay_rw 目录
4. **宿主机 EGL 库直接绑定**: 容器内 Android 直接使用宿主机的 GPU 驱动

### 配置系统

Waydroid 的配置存储在 `/var/lib/waydroid/waydroid.cfg`，采用 INI 格式。从 `tools/config/__init__.py` 可以看到默认值：

```python
version = "1.6.2"

defaults = {
    "arch": "arm64",
    "work": "/var/lib/waydroid",
    "vendor_type": "MAINLINE",
    "suspend_action": "freeze",      # 挂起时冻结容器
    "mount_overlays": "True",        # 启用 OverlayFS
    "auto_adb": "False",             # 自动连接 ADB
    "container_xdg_runtime_dir": "/run/xdg",
    "container_wayland_display": "wayland-0",
}

channels_defaults = {
    "system_channel": "https://ota.waydro.id/system",
    "vendor_channel": "https://ota.waydro.id/vendor",
    "rom_type": "lineage",
    "system_type": "VANILLA"         # 或 GAPPS (含 Google 应用)
}
```

会话配置则来自用户环境：

```python
session_defaults = {
    "user_name": pwd.getpwuid(os.getuid()).pw_name,
    "xdg_runtime_dir": os.environ.get('XDG_RUNTIME_DIR'),
    "wayland_display": os.environ.get('WAYLAND_DISPLAY'),
    "pulse_runtime_path": os.environ.get('PULSE_RUNTIME_PATH'),
    "waydroid_data": "~/.local/share/waydroid/data",
    "lcd_density": "0",
    "background_start": "true"
}
```

### 网络架构

Waydroid 通过 `waydroid-net.sh` 脚本建立容器网络。网络拓扑：

```
宿主机物理网卡 (e.g., wlan0)
    │
    │  iptables/nftables NAT MASQUERADE
    │
waydroid0 网桥 (192.168.240.1/24)
    │  MAC: 00:16:3e:00:00:01
    │
    │  dnsmasq DHCP (192.168.240.2-254)
    │
veth pair
    │
容器内 eth0
```

脚本的核心步骤：

```bash
# 1. 创建网桥
ip link add dev waydroid0 type bridge
echo 1 > /proc/sys/net/ipv4/ip_forward

# 2. 配置 IP
ip addr add 192.168.240.1/24 broadcast + dev waydroid0
ip link set dev waydroid0 address 00:16:3e:00:00:01
ip link set dev waydroid0 up

# 3. 防火墙 (iptables 或 nftables)
iptables -I INPUT -i waydroid0 -p udp --dport 67 -j ACCEPT   # DHCP
iptables -I INPUT -i waydroid0 -p udp --dport 53 -j ACCEPT   # DNS
iptables -I FORWARD -i waydroid0 -j ACCEPT                    # 转发
iptables -t nat -A POSTROUTING -s 192.168.240.0/24 ! -d 192.168.240.0/24 -j MASQUERADE

# 4. DHCP 服务
dnsmasq --listen-address 192.168.240.1 \
        --dhcp-range 192.168.240.2,192.168.240.254 \
        --interface=waydroid0
```

### IPC 双层架构

Waydroid 使用两种 IPC 机制：

**1. D-Bus（宿主机 ↔ Waydroid 工具）**

```
                    System Bus                    Session Bus
                        │                              │
                ┌───────┴───────┐              ┌───────┴───────┐
                │ id.waydro.    │              │ id.waydro.    │
                │ Container     │              │ Session       │
                │               │              │               │
                │ /Container    │              │ /Session      │
                │   Manager     │              │   Manager     │
                │   .Start()    │              │   .Stop()     │
                │   .Stop()     │              │               │
                │   .Freeze()   │              │               │
                │   .GetSession │              │               │
                │               │              │               │
                │ /Initializer  │              │               │
                │   .Init()     │              │               │
                │   .Cancel()   │              │               │
                └───────────────┘              └───────────────┘
```

**2. Binder（Waydroid 工具 ↔ Android）**

通过 `gbinder` 库，Python 工具直接与容器内的 Android 服务通信：

```
waydroid app launch <package>
    │
    └─ gbinder → /dev/binder → lineageos.waydroid.IPlatform
                                    │
                                    ├─ installApp()
                                    ├─ launchApp()
                                    ├─ removeApp()
                                    ├─ getAppsInfo()
                                    ├─ getprop() / setprop()
                                    └─ ...
```

### 硬件属性自动检测

初始化时，`make_base_props()`（`tools/helpers/lxc.py:221`）自动检测宿主机硬件并生成 Android 属性文件：

```python
def make_base_props(args):
    props = []

    # Gralloc HAL 检测
    gralloc = find_hal("gralloc")
    if not gralloc:
        if dri:
            gralloc = "gbm"       # 有 DRI 节点 → 使用 GBM
            egl = "mesa"
            props.append("gralloc.gbm.device=" + dri)
        else:
            gralloc = "default"    # 无 GPU → 软件渲染
            egl = "swiftshader"

    # Vulkan 驱动映射
    vulkan = find_hal("vulkan")
    if not vulkan and dri:
        vulkan = tools.helpers.gpu.getVulkanDriver(args, os.path.basename(dri))

    # Camera HAL
    if args.vendor_type == "MAINLINE":
        props.append("ro.hardware.camera=v4l2")   # 使用 V4L2 摄像头

    # OpenGL ES 版本
    opengles = helpers.props.host_get(args, "ro.opengles.version")
    if opengles == "":
        opengles = "196610"   # 默认 OpenGL ES 3.2
```

---

## 设计哲学总结

通过源码分析，我们可以提炼出 Waydroid 的几个核心设计哲学：

### 1. 性能优先的"半容器化"

Waydroid 不追求完美的安全隔离。HAL 层的 HWComposer 和 Audio HAL 以 `host` 用户运行，直接访问宿主机的 Wayland socket 和 ALSA 设备。这是一个精心权衡的设计——完整的容器隔离意味着需要通过 virtio 等虚拟化手段传递图形和音频，这会带来显著的性能损失。

### 2. 适配而非修改宿主机

Waydroid 不修改宿主机的内核或桌面环境。它通过：
- 动态加载内核模块（而非要求编译进内核）
- 使用标准 Wayland 协议（而非自定义显示协议）
- 生成 `.desktop` 文件（而非自定义应用启动器）

来最大程度地"适配"宿主机环境。

### 3. OverlayFS 实现不可变基础设施

系统镜像只读 + OverlayFS 可写层的设计，借鉴了容器和不可变基础设施的理念。系统更新是原子性的（替换镜像文件），回滚是简单的（删除 overlay_rw）。

### 4. 自动化硬件检测

Waydroid 在初始化时自动检测 GPU 类型、gralloc 实现、Vulkan 驱动等，生成对应的 Android 属性文件。用户无需手动配置硬件参数。

---

## 下一篇预告

在下一篇文章中，我们将深入分析 **容器管理与系统初始化** 模块——包括 Binder 驱动的分配策略、LXC 配置的动态生成、OverlayFS 挂载的完整过程，以及 OTA 镜像下载和校验的实现细节。

---

*本文基于 [Waydroid](https://github.com/waydroid) 项目源码分析，源码版本 v1.6.2。*
