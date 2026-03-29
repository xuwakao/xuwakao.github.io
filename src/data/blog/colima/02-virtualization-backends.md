---
title: "Colima运行linux容器（二）：QEMU / VZ / Krunkit 三种虚拟化后端"
description: "对比 QEMU、Apple Virtualization.framework 和 Krunkit 三种虚拟化后端的架构差异和性能特点"
pubDatetime: 2025-01-14T00:00:00Z
modDatetime: 2025-01-14T00:00:00Z
author: "xuwakao"
slug: "linux-container-virtualization-backends"
tags:
  - container
  - linux
  - virtualization
  - qemu
  - colima
featured: false
---

# Colima运行linux容器（二）：QEMU / VZ / Krunkit 三种虚拟化后端

> 基于 Colima 源码深度分析

## 一、问题的本质

在 macOS 上跑 Linux 容器，核心需要解决一个问题：**怎么在 macOS 上跑一个 Linux 内核？**

答案是虚拟化。但虚拟化有多种路径，Colima 支持三种引擎，适配不同场景。

## 二、Lima：虚拟化管理层

在讲三种引擎之前，需要先理解 **Lima** 的角色。

Lima 不是虚拟化引擎本身。它是一个 **VM 生命周期管理器**——类似于 Vagrant 之于 VirtualBox 的关系。Lima 的职责：

1. 接收一份 YAML 配置文件，描述 VM 的参数
2. 调用底层虚拟化引擎（QEMU/VZ/Krunkit）创建 VM
3. 管理 VM 的启动、停止、SSH 连接
4. 实现端口转发、文件挂载、Socket 共享

Colima 不直接调用 QEMU/VZ，而是通过 Lima 间接管理。所有 VM 操作最终走 `limactl` 命令：

```go
// environment/vm/lima/lima.go
// 启动 VM
host.Run("limactl", "start", "--tty=false", yamlFilePath)

// SSH 进 VM
host.Run("limactl", "shell", profileID, "sudo", "systemctl", "start", "docker")

// 停止 VM
host.Run("limactl", "stop", profileID)
```

## 三、QEMU — 软件模拟的万能选手

### 3.1 什么是 QEMU

QEMU (Quick EMUlator) 是一个开源的通用机器模拟器和虚拟化器。它可以：
- **完全模拟**一台机器的 CPU、内存、设备（软件模拟，跨架构）
- **借助 KVM/HVF 加速**：在宿主 CPU 和客户 CPU 同架构时，用硬件虚拟化加速

在 macOS 上，QEMU 配合 Apple 的 **Hypervisor.framework (HVF)** 实现硬件加速。

### 3.2 Colima 中的 QEMU 配置

QEMU 是 Colima 的**默认**虚拟化后端：

```go
// environment/vm/lima/yaml.go:28
l.VMType = limaconfig.QEMU  // 默认就是 QEMU
```

当使用 QEMU 时，相关配置：

```go
// CPU 类型定制
if conf.CPUType != "" && conf.CPUType != "host" {
    l.VMOpts.QEMU.CPUType = map[environment.Arch]string{
        l.Arch: conf.CPUType,  // 如 "cortex-a72" 或 "max"
    }
}

// 文件系统挂载方式：9p
// QEMU 下默认使用 9p 文件系统协议来共享目录
l.MountType = limaconfig.NINEP  // "9p"
```

### 3.3 QEMU 的跨架构能力

QEMU 是三种引擎中唯一支持 **VM 级跨架构** 的——可以在 ARM Mac 上跑 x86_64 的 Linux VM（整台 VM 全模拟）：

```go
// yaml.go:30
sameArchitecture := environment.HostArch() == l.Arch

// VZ 和 Krunkit 都要求 sameArchitecture == true
// 只有 QEMU 允许 sameArchitecture == false
```

不过实际中更常见的做法不是跑跨架构 VM，而是跑同架构 VM + 在 VM 内用 binfmt 翻译个别 x86 二进制（详见第八节）。跨架构 VM 的全模拟开销过大，仅在特殊场景（如需要完整 x86 内核环境）才使用。

### 3.4 QEMU 模式下的网络

```go
// QEMU + 需要可达 IP 地址时，使用 vmnet socket
if util.MacOS() && reachableIPAddress {
    socketFile := vmnet.Info().Socket.File()
    l.Networks = append(l.Networks, limaconfig.Network{
        Socket:    socketFile,       // vmnet daemon 的 socket
        Interface: limautil.NetInterface,
        Metric:    metric,
    })
}
```

QEMU 模式下，如果需要 VM 有一个宿主机可达的 IP 地址，需要借助 **vmnet** 守护进程提供桥接网络。

### 3.5 QEMU 的优缺点

| 优点 | 缺点 |
|------|------|
| 跨架构支持（ARM 跑 x86） | 同架构下性能不如 VZ |
| 成熟稳定，社区庞大 | 9p 文件共享性能一般 |
| 不依赖特定 macOS 版本 | 首次启动较慢 |
| 自定义 CPU 类型 | 内存开销稍大 |

## 四、VZ — Apple 原生虚拟化框架

### 4.1 什么是 VZ

VZ 指的是 Apple 的 **Virtualization.framework**，macOS 13 (Ventura) 引入。它是 Apple 官方的**高层虚拟化 API**，底层基于 Hypervisor.framework（这个才类似于 Linux 的 KVM）。

如果做类比：
- **Hypervisor.framework** ≈ Linux KVM — 提供底层 CPU 虚拟化原语
- **Virtualization.framework** ≈ QEMU（的高层部分） — 在 Hypervisor.framework 之上封装了设备模拟、启动引导、文件共享等完整能力

核心优势：**Apple 原生集成**，无需 QEMU 这样的第三方中间层，API 更简洁，启动更快。

### 4.2 启用条件

源码揭示了 VZ 的严格前提条件：

```go
// environment/vm/lima/yaml.go:33-35
if util.MacOS13OrNewer() && conf.VMType == limaconfig.VZ && sameArchitecture {
    l.VMType = limaconfig.VZ
```

三个硬性条件：
1. **macOS 13+**（Ventura 或更新）
2. **用户显式选择** VZ（`conf.VMType == "vz"`）
3. **同架构**（ARM Mac 跑 ARM Linux，Intel Mac 跑 x86 Linux）

### 4.3 VZ 的独有能力

#### virtiofs 文件共享

VZ 模式下，文件挂载使用 **virtiofs** 而非 QEMU 的 9p：

```go
// yaml.go:345-347
if l.VMType == limaconfig.VZ {
    l.MountType = limaconfig.VIRTIOFS  // VZ 专用，性能远超 9p 和 sshfs
}
```

virtiofs 是为虚拟化场景专门设计的高性能文件系统协议。在实际使用中，文件读写性能可以接近原生。

#### Rosetta 2 集成

VZ 的关键特性之一：在 ARM Linux VM 内通过 Rosetta 2 运行 x86_64 二进制，接近原生速度：

```go
// yaml.go:37-45
if conf.VZRosetta && util.MacOS13OrNewerOnArm() {
    if util.RosettaRunning() {
        l.VMOpts.VZOpts.Rosetta.Enabled = true  // 启用 Rosetta
        l.VMOpts.VZOpts.Rosetta.BinFmt = true   // 注册为 binfmt handler
    }
}
```

**工作原理**：
1. macOS 的 Rosetta 2 本来是用来翻译 x86 macOS 程序的
2. Apple 的 Virtualization.framework 能把 Rosetta 暴露给 Linux VM
3. Linux 内核通过 binfmt_misc 注册 Rosetta 作为 x86_64 的翻译器
4. 当 VM 内尝试运行 x86_64 ELF 二进制时，Rosetta 自动翻译为 ARM 指令

**检测 Rosetta 是否安装**：

```go
// util/macos.go:132-141
func RosettaRunning() bool {
    if !MacOS() { return false }
    cmd := cli.Command("pgrep", "oahd")  // oahd 是 Rosetta 的守护进程
    return cmd.Run() == nil
}
```

**意义**：在 ARM Mac 上，使用 VZ + Rosetta 可以几乎无性能损失地运行 x86_64 Docker 镜像，远优于 QEMU 的纯软件模拟。

#### 嵌套虚拟化

```go
// yaml.go:47-49
if util.MacOSNestedVirtualizationSupported() {
    l.NestedVirtualization = conf.NestedVirtualization
}
```

支持在 VM 内再跑 VM（需要 macOS 15+ 和 M3+ 芯片）。

#### VZNAT 网络

```go
// yaml.go:157-163
if l.VMType == limaconfig.VZ && conf.Network.Mode != "bridged" {
    l.Networks = append(l.Networks, limaconfig.Network{
        VZNAT:     true,                    // VZ 原生 NAT
        Interface: limautil.NetInterface,
        Metric:    metric,
    })
}
```

VZ 有自己的 NAT 实现，不需要 vmnet 守护进程（QEMU 则需要）。

### 4.4 VZ 的优缺点

| 优点 | 缺点 |
|------|------|
| 原生 macOS 集成，启动极快 | 只支持 macOS 13+ |
| virtiofs 文件共享性能最优 | VM 本身必须同架构（不能在 ARM 上跑 x86 VM） |
| Rosetta 2 高效 x86 翻译 | Rosetta 仅支持 ARM→x86 方向（Intel Mac 无法跑 ARM） |
| VZNAT 原生网络 | 较新，边界情况可能有 bug |
| 嵌套虚拟化（M3+） | |

## 五、Krunkit — 容器化的虚拟化

### 5.1 什么是 Krunkit

Krunkit 基于 [libkrun](https://github.com/containers/libkrun)，一个将虚拟化封装成"进程"的库。它使用 Apple 的 Hypervisor.framework（在 macOS 上），设计理念与传统 VM 不同：不是创建一个完整的虚拟机，而是创建一个**最小化的隔离环境**（microVM），启动开销极低。

### 5.2 启用条件

最严格的条件：

```go
// yaml.go:52-54
if util.MacOS13OrNewerOnArm() && conf.VMType == limaconfig.Krunkit && sameArchitecture {
    l.VMType = limaconfig.Krunkit
```

三个条件：
1. macOS 13+ **且是 ARM** (`MacOS13OrNewerOnArm`)
2. 显式选择 krunkit
3. 同架构

**注意**：Intel Mac 完全不支持 Krunkit。

### 5.3 Krunkit 的定位

Krunkit 代表了虚拟化的一个新方向：**microVM**。它的目标是让虚拟化的开销尽可能小，接近原生容器的体验。但目前在 Colima 中还是实验性的。

## 六、选择决策树

源码中的选择逻辑可以归纳为这棵决策树：

```
用户配置的 VMType 是什么？
│
├── "qemu"（或未指定）
│   └── 使用 QEMU
│       ├── 挂载：9p
│       ├── 网络：vmnet socket（需要可达 IP 时）
│       └── 跨架构？ ✅ 支持
│
├── "vz"
│   ├── macOS 13+ ?
│   │   ├── 否 → 回退到 QEMU
│   │   └── 是 → 同架构？
│   │       ├── 否 → 回退到 QEMU
│   │       └── 是 → 使用 VZ ✅
│   │           ├── 挂载：virtiofs
│   │           ├── 网络：VZNAT
│   │           ├── Rosetta？ ARM Mac + oahd 运行中 → 启用
│   │           └── 嵌套虚拟化？ macOS 15 + M3+ → 可启用
│   │
│   └── 最终：VZ 或 QEMU
│
└── "krunkit"
    ├── macOS 13+ ARM ?
    │   ├── 否 → 回退到 QEMU
    │   └── 是 → 同架构？
    │       ├── 否 → 回退到 QEMU
    │       └── 是 → 使用 Krunkit ✅
    │
    └── 最终：Krunkit 或 QEMU
```

## 七、挂载方式对比

挂载方式决定了宿主机文件在 VM 内的访问性能，这对开发体验至关重要：

```go
// yaml.go:342-351 — 挂载类型选择逻辑
switch strings.ToLower(conf.MountType) {
case "ssh", "sshfs", "reversessh", "reverse-ssh", "reversesshfs", limaconfig.REVSSHFS:
    l.MountType = limaconfig.REVSSHFS   // 用户显式选择 sshfs
default:
    if l.VMType == limaconfig.VZ {
        l.MountType = limaconfig.VIRTIOFS  // VZ → virtiofs
    } else {
        l.MountType = limaconfig.NINEP     // QEMU → 9p
    }
}
```

| 挂载方式 | 虚拟化引擎 | 性能 | 原理 |
|---------|-----------|------|------|
| **virtiofs** | VZ | 最优 | VirtIO 设备直通，内核级文件共享 |
| **9p** | QEMU | 中等 | Plan 9 网络文件系统协议 |
| **reverse-sshfs** | 任意 | 较低 | 通过 SSH 反向挂载 SFTP |

virtiofs 的性能优势是选择 VZ 的重要原因之一。对于 `node_modules` 这样包含大量小文件的场景，virtiofs 相对于 sshfs 有数量级的性能优势（具体倍数视 I/O 模式而定）。

## 八、跨架构运行：两个层面的问题

"在 ARM Mac 上跑 x86_64 容器"涉及两个不同层面，需要区分清楚：

### 8.1 VM 层面：整台虚拟机跨架构

QEMU 可以在 ARM Mac 上跑一台 x86_64 的 Linux VM——这意味着 VM 内的所有东西（内核、systemd、Docker、容器）都是 x86_64 的。这是 VZ/Krunkit 做不到的（它们要求同架构）。

但实际中很少用这种方式，因为整台 VM 的每条指令都要软件模拟，极慢。

### 8.2 二进制层面：同架构 VM 内翻译个别二进制（常用方式）

更实际的方案是：**跑一个同架构的 ARM VM，在 VM 内部通过 binfmt_misc 翻译个别 x86_64 二进制**。

源码中可以看到，binfmt 设置**仅在 VM 与宿主机同架构时**才执行：

```go
// environment/vm/lima/lima.go:302-308
// use binfmt when emulation is disabled i.e. host arch
if conf.Binfmt != nil && *conf.Binfmt {
    if arch := environment.HostArch(); arch == environment.Arch(conf.Arch).Value() {
        // 关键：只在同架构 VM 内设置 binfmt
        core.SetupBinfmt(l.host, l, environment.Arch(conf.Arch))
    }
}
```

这意味着：ARM Mac → ARM Linux VM → 在 VM 内用 binfmt 翻译 x86_64 容器镜像中的二进制。

翻译引擎有两个选择：

**QEMU 用户态模拟**：安装 `qemu-user-static`，注册为 binfmt handler。纯软件逐指令翻译，性能损失显著（通常在 5-20x 量级，视工作负载而定）。

**Rosetta 2**（VZ 模式下）：由 Apple Virtualization.framework 将 Rosetta 暴露给 VM，注册为 binfmt handler。通过 AOT 编译翻译，接近原生速度。

```go
// environment/vm/lima/lima.go:311-325
if l.limaConf.VMOpts.VZOpts.Rosetta.Enabled {
    // 注册 Rosetta 为 x86_64 ELF 的 binfmt handler
    l.Run("sudo", "sh", "-c", `echo ':rosetta:M::...' > /proc/sys/fs/binfmt_misc/register`)

    // 如果同时存在 qemu-x86_64 handler，禁用它（Rosetta 优先）
    if l.RunQuiet("stat", "/proc/sys/fs/binfmt_misc/qemu-x86_64") == nil {
        l.Run("sudo", "sh", "-c", `echo 0 > /proc/sys/fs/binfmt_misc/qemu-x86_64`)
    }
}
```

注意源码中 Rosetta 启用后会**主动禁用 QEMU 的 x86_64 handler**，确保 Rosetta 优先。

### 8.3 对比

```
                    在 ARM Mac 上运行 x86_64 容器镜像
                    ═══════════════════════════════════

方式 1（极少用）：x86_64 VM（整台 VM 全模拟）
  宿主机 ARM → QEMU 模拟 x86_64 硬件 → x86 Linux 内核 → x86 容器
  性能：极差，一切都在模拟

方式 2：ARM VM + QEMU 用户态（binfmt）
  宿主机 ARM → ARM VM → ARM Linux 内核
    → 容器内遇到 x86_64 ELF → binfmt → qemu-user-static 逐指令翻译
  性能：★★☆☆☆（仅容器内的 x86 二进制受影响）

方式 3：ARM VM + Rosetta 2（binfmt）
  宿主机 ARM → VZ ARM VM → ARM Linux 内核
    → 容器内遇到 x86_64 ELF → binfmt → Rosetta AOT 编译 → 硬件执行
  性能：★★★★☆（接近原生）

原生：ARM VM + ARM 容器
  性能：★★★★★
```

## 九、小结

三种虚拟化后端的核心差异：

| 维度 | QEMU | VZ | Krunkit |
|------|------|-----|---------|
| **本质** | 通用模拟器 | Apple 原生 hypervisor | microVM |
| **最低要求** | 任何 macOS | macOS 13, 同架构 | macOS 13, ARM, 同架构 |
| **文件共享** | 9p | virtiofs | - |
| **跨架构** | 完全支持（软件模拟） | VM 同架构 + Rosetta 翻译 x86 二进制 | 不支持 |
| **网络** | vmnet socket | VZNAT | - |
| **启动速度** | 较慢 | 快 | 最快 |
| **适用场景** | 兼容性优先、跨架构 | Apple Silicon 性能优先 | 实验性 |

从源码的选择逻辑可以看出 Colima 的设计意图：QEMU 作为最大兼容性的兜底，VZ 在条件满足时提供最优性能路径，Krunkit 留给未来的 microVM 方向探索。

下一篇将深入分析 **VM 的完整生命周期**——从 `colima start` 到 Linux 内核启动的每一步。
