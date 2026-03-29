---
title: "Colima运行linux容器（一）：为什么需要一个 VM"
description: "解析 macOS/Windows 上运行 Linux 容器为什么必须依赖虚拟机，从内核层面理解容器的本质约束"
pubDatetime: 2025-01-07T00:00:00Z
modDatetime: 2025-01-07T00:00:00Z
author: "xuwakao"
slug: "linux-container-why-vm"
tags:
  - container
  - linux
  - virtualization
  - colima
featured: false
---

# Colima运行linux容器（一）：为什么需要一个 VM

> 基于 Colima 源码深度分析

## 〇、这个系列在讲什么

每天有大量开发者在 macOS 上执行 `docker run`，但很少有人想过一个问题：**Docker 容器是 Linux 内核的功能，macOS 根本没有这套内核机制——它是怎么跑起来的？**

答案是：在 macOS 上悄悄跑了一个 Linux 虚拟机，容器实际运行在这个 VM 里。Docker Desktop 如此，Podman 如此，本系列分析的 **Colima** 也是如此。

### Colima 是什么

[Colima](https://github.com/abiosoft/colima)（**Co**ntainers on **Lima**）是一个开源的 macOS 容器运行环境。它的目标很明确：**让你在 macOS 上一条命令就能用上 Docker（以及 containerd、Kubernetes、Incus）**。

```bash
brew install colima
colima start        # 一条命令：创建 VM → 启动 Docker → 配置转发 → 就绪
docker run hello-world  # 直接可用，和 Linux 上体验一致
```

它是 Docker Desktop 的开源替代品。Docker Desktop 从 2021 年起对中大型企业收费，而 Colima 用开源组件（Lima + QEMU/Apple VZ）实现了相同的核心能力：在 macOS 上透明地运行 Linux 容器。

### 系列目录

1. **本文**：容器为什么依赖 Linux 内核？macOS 上为什么必须有 VM？
2. **[虚拟化后端篇](02-virtualization-backends.md)**：QEMU / Apple VZ / Krunkit 三种引擎怎么选？
3. **[VM 生命周期篇](03-vm-lifecycle.md)**：从 `colima start` 到 Linux 内核启动经历了什么？
4. **[容器运行时篇](04-container-runtime.md)**：Docker daemon 在 VM 内如何被安装和启动？
5. **[宿主机-VM 桥接篇](05-host-vm-bridge.md)**：Socket/端口/文件/网络四条通道如何让 VM 透明？
6. **[方案横评篇](06-comparison.md)**：Docker Desktop / Colima / OrbStack / Podman 关键差异对比

---

## 一、容器不是虚拟机——它是 Linux 内核特性

很多人以为"容器"是一种轻量虚拟机。实际上，容器是 **Linux 内核** 提供的一组隔离机制的组合：

| 内核特性 | 作用 |
|---------|------|
| **Namespaces** | 隔离进程视野（PID/NET/MNT/UTS/IPC/USER） |
| **Cgroups** | 限制资源使用（CPU/内存/IO） |
| **Union FS** | 镜像分层存储（OverlayFS） |
| **Seccomp/AppArmor** | 系统调用过滤与安全策略 |
| **veth/bridge** | 容器网络虚拟化 |

这些都是 **Linux 内核独有的特性**。没有 Linux 内核，就没有容器。

当你在 macOS 上运行 `docker run alpine echo hello` 时，实际上：
- macOS 的 Darwin 内核**没有** namespaces、cgroups、OverlayFS
- `echo hello` 必须跑在一个**真正的 Linux 内核**上
- 因此必须有一层虚拟化，把一个 Linux 内核跑起来

**这就是为什么在 macOS/Windows 上运行容器，一定需要一个 Linux VM。**

> 注：Windows 上的 WSL2 是一个特殊案例——它在 Hyper-V 虚拟化之上运行了一个真正的 Linux 内核，本质上也是 VM 方案，只是与 Windows 内核做了更深度的集成（文件系统互通、进程可见等）。本系列聚焦 **macOS + Colima** 的实现。

## 二、行业方案全景

不同产品选择了不同的虚拟化策略：

```
                    macOS/Windows 上跑 Linux 容器的方案
                    ═══════════════════════════════════

┌─────────────────┬──────────────────────┬────────────────────┐
│  Docker Desktop │     Colima           │     Podman         │
├─────────────────┼──────────────────────┼────────────────────┤
│  自研 LinuxKit  │     Lima + QEMU/VZ   │     podman machine │
│  + Apple VZ     │                      │     + QEMU/VZ      │
│  Framework      │                      │                    │
├─────────────────┴──────────────────────┴────────────────────┤
│                                                             │
│   所有方案的本质都是一样的：                                   │
│                                                             │
│   macOS ←──socket/SSH──→ Linux VM ←──→ 容器运行时            │
│                                                             │
│   区别只在于：                                                │
│   1. 用什么虚拟化引擎（QEMU/VZ/HyperKit/libkrun）            │
│   2. 用什么 Linux 发行版（LinuxKit/Ubuntu/Alpine/Fedora）     │
│   3. 怎么打通宿主机和 VM 的通信                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 三、Colima 的架构选择

Colima 的核心策略是：**不重新发明轮子，组合现有最佳方案**。

```
┌─────────────────────────────────────────────────────────┐
│                    macOS 宿主机                          │
│                                                         │
│  ┌──────────┐    ┌──────────────────────────────────┐   │
│  │  用户     │    │          Colima                   │   │
│  │  docker   │    │  ┌──────┐  ┌──────┐  ┌────────┐ │   │
│  │  命令     │◄──►│  │ App  │──│Config│──│Profile │ │   │
│  └──────────┘    │  └──┬───┘  └──────┘  └────────┘ │   │
│       ▲          │     │                             │   │
│       │          │     ▼                             │   │
│  ┌────┴─────┐    │  ┌──────────────────────────┐    │   │
│  │  Docker  │    │  │        Lima               │    │   │
│  │  Context │    │  │  ┌────────────────────┐   │    │   │
│  │  (unix   │    │  │  │ 虚拟化引擎选择      │   │    │   │
│  │  socket) │    │  │  │ QEMU / VZ / Krunkit│   │    │   │
│  └──────────┘    │  │  └─────────┬──────────┘   │    │   │
│                  │  │            │               │    │   │
│                  │  │  ┌─────────▼──────────┐   │    │   │
│                  │  │  │ SSH 隧道 + Socket  │   │    │   │
│                  │  │  │ 端口转发            │   │    │   │
│                  │  │  └─────────┬──────────┘   │    │   │
│                  │  └────────────│───────────┘   │   │
│                  └───────────────│────────────────┘   │
│                                 │                     │
├─────────────────────────────────│─────────────────────┤
│                    虚拟化边界    │                     │
├─────────────────────────────────│─────────────────────┤
│                                 ▼                     │
│  ┌──────────────────────────────────────────────────┐ │
│  │              Linux VM                             │ │
│  │  ┌────────────────────────────────────────────┐  │ │
│  │  │           Linux Kernel                     │  │ │
│  │  │  namespaces / cgroups / overlayfs / veth   │  │ │
│  │  └─────────────────┬──────────────────────────┘  │ │
│  │                    │                              │ │
│  │  ┌─────────────────▼──────────────────────────┐  │ │
│  │  │         容器运行时                          │  │ │
│  │  │  Docker daemon / containerd / Incus        │  │ │
│  │  └─────────────────┬──────────────────────────┘  │ │
│  │                    │                              │ │
│  │  ┌─────────────────▼──────────────────────────┐  │ │
│  │  │         容器                                │  │ │
│  │  │  ┌──────┐ ┌──────┐ ┌──────┐               │  │ │
│  │  │  │nginx │ │redis │ │app   │ ...            │  │ │
│  │  │  └──────┘ └──────┘ └──────┘               │  │ │
│  │  └────────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

各层的职责：

| 层 | 负责什么 | 对应代码 |
|----|---------|---------|
| **Colima App** | 编排整个生命周期 | `app/app.go` |
| **Config** | 用户意图（CPU/内存/运行时/网络） | `config/config.go` |
| **Lima** | 翻译为 VM 配置，管理 VM 生命周期 | `environment/vm/lima/` |
| **虚拟化引擎** | 实际创建和运行 VM | QEMU/VZ/Krunkit |
| **Linux VM** | 提供真正的 Linux 内核 | Ubuntu/Alpine 镜像 |
| **容器运行时** | 在 Linux 内核上管理容器 | `environment/container/` |
| **桥接层** | Socket 转发、端口映射、卷挂载 | Lima SSH + yaml 配置 |

## 四、Colima 中的关键抽象

### 4.1 两个核心接口

Colima 用两个接口抽象了"宿主机"和"VM"之间的界限：

```go
// environment/environment.go

// HostActions — 在 macOS 上执行的操作（environment/environment.go）
type HostActions interface {
    runActions   // Run, RunQuiet, RunOutput, RunInteractive, RunWith
    fileActions  // Read, Write, Stat
    WithEnv(env ...string) HostActions  // 链式设置环境变量
    WithDir(dir string) HostActions     // 链式设置工作目录
    Env(string) string                  // 读宿主机环境变量
}

// GuestActions — 在 Linux VM 内执行的操作（environment/environment.go）
type GuestActions interface {
    runActions   // Run, RunQuiet, RunOutput, RunInteractive, RunWith
    fileActions  // Read, Write, Stat
    Start(ctx context.Context, conf config.Config) error  // 启动 VM
    Stop(ctx context.Context, force bool) error
    Restart(ctx context.Context) error
    SSH(workingDir string, args ...string) error  // SSH 进 VM
    Created() bool                                // VM 是否已创建
    Running(ctx context.Context) bool             // VM 是否在运行
    Arch() Arch                                   // VM 的 CPU 架构
    Get(key string) string                        // 读 VM 配置
    Set(key, value string) error                  // 写 VM 配置
}
```

这两个接口是整个系统的基石。**所有容器运行时的安装和管理，都是通过 GuestActions 在 VM 内执行命令完成的**——本质上就是通过 SSH 跑 shell 脚本。

### 4.2 Container 接口

```go
// Container — 容器运行时的统一抽象（environment/container.go）
type Container interface {
    Name() string                            // "docker" / "containerd" / "incus"
    Provision(ctx context.Context) error     // 安装和配置（幂等）
    Start(ctx context.Context) error         // 启动
    Stop(ctx context.Context, force bool) error
    Teardown(ctx context.Context) error      // 卸载清理
    Update(ctx context.Context) (bool, error) // 更新
    Version(ctx context.Context) string
    Running(ctx context.Context) bool
    Dependencies                             // 嵌入 Dependencies 接口
}
```

Docker、containerd、Incus、Kubernetes 都实现了这个接口。

### 4.3 启动编排

`app/app.go` 中的 `Start()` 方法揭示了核心编排逻辑：

```go
// app/app.go:102-161（简化）
func (c colimaApp) Start(conf config.Config) error {
    // 第一步：启动 Linux VM
    c.guest.Start(ctx, conf)

    // 第二步：执行用户的 after-boot 自定义脚本
    c.runProvisionScripts(conf, ProvisionModeAfterBoot)

    // 第三步：在 VM 内安装并启动容器运行时
    for _, cont := range containers {
        cont.Provision(ctx)  // 安装配置
        cont.Start(ctx)      // 启动服务
    }

    // 第四步：执行用户的 ready 自定义脚本
    c.runProvisionScripts(conf, ProvisionModeReady)

    // 第五步：持久化运行时和 K8s 配置，生成 SSH config
    // ...
}
```

核心流程：
1. 先有 Linux 内核（启动 VM）
2. 再有容器运行时（在 VM 内安装 Docker/containerd）
3. 然后宿主机就可以用了（通过 socket 转发透明访问）

## 五、一次 `docker run` 的完整旅程

当你在 macOS 上运行 `docker run -p 8080:80 nginx` 时，发生了什么：

```
macOS Terminal
  │
  │ docker run -p 8080:80 nginx
  │
  ▼
Docker CLI（macOS 原生二进制）
  │
  │ 读取 Docker context "colima"
  │ 连接到 unix:///Users/you/.colima/colima/docker.sock
  │
  ▼
Lima SSH 隧道
  │
  │ 通过 SSH 端口转发，将 socket 连接传递到 VM 内
  │
  ▼
Linux VM 内的 /run/docker.sock
  │
  ▼
dockerd（Docker daemon，跑在 Linux 内核上）
  │
  │ 1. 拉取 nginx 镜像（通过 VM 的网络）
  │ 2. 调用 containerd → runc → Linux 内核
  │ 3. 创建 namespaces + cgroups 隔离环境
  │ 4. 启动 nginx 进程
  │ 5. 配置 veth 网桥，监听 80 端口
  │
  ▼
Lima 端口转发
  │
  │ VM 内的 80 端口 → macOS 的 8080 端口
  │
  ▼
macOS localhost:8080 可访问 nginx
```

整个过程中，用户完全感知不到 VM 的存在——这正是 Colima + Lima 的设计目标：让 VM 层对用户透明。

## 六、与 Docker Desktop 的对比

| 维度 | Docker Desktop | Colima |
|------|---------------|--------|
| **虚拟化引擎** | Apple Virtualization.framework | QEMU / VZ / Krunkit（可选） |
| **Linux 发行版** | LinuxKit（自研精简版） | Ubuntu（Lima 默认） |
| **VM 管理器** | 自研 | Lima（开源） |
| **Socket 转发** | gRPC + vsock | SSH 隧道 / gRPC |
| **文件挂载** | virtiofs / VirtioFS FUSE | virtiofs / 9p / reverse-sshfs |
| **开源协议** | 商业协议（企业需付费） | 完全开源（MIT） |

**本质上是同一件事**：在 macOS 上跑一个 Linux VM，在 VM 内跑容器，然后把 socket/端口/文件系统打通。

下一篇深入分析 Colima 支持的 **[三种虚拟化引擎](02-virtualization-backends.md)** —— QEMU、Apple VZ、Krunkit 各自的原理和适用场景。
