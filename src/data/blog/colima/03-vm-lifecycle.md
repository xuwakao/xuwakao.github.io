---
title: "Colima运行linux容器（三）：VM 生命周期 — 从 colima start 到 Linux 内核启动"
description: "追踪 colima start 的完整执行链路，分析 VM 创建、配置、启动到 Linux 内核引导的全过程"
pubDatetime: 2025-01-22T00:00:00Z
modDatetime: 2025-01-22T00:00:00Z
author: "xuwakao"
slug: "linux-container-vm-lifecycle"
tags:
  - container
  - linux
  - colima
  - vm
featured: false
---

# Colima运行linux容器（三）：VM 生命周期 — 从 colima start 到 Linux 内核启动

> 基于 Colima 源码深度分析

## 一、全流程概览

当用户执行 `colima start` 时，要完成从"macOS 宿主机"到"Linux VM 内容器就绪"的全过程。这个过程可以分为五个阶段：

```
Phase 1          Phase 2           Phase 3           Phase 4          Phase 5
宿主机准备  ──→  VM 配置生成  ──→  VM 启动引导  ──→  VM 内置备  ──→  容器运行时
                                                                    安装启动

startDaemon()    newConf()         limactl start     setupDNS()      Provision()
createDisk()     downloadImage()   Linux 内核启动    copyCerts()     Start()
                 writeNetwork()    systemd init      emulation
                                   provision 脚本    网络配置
```

## 二、Phase 1：宿主机准备

### 2.1 启动守护进程

```go
// environment/vm/lima/lima.go
func (l *limaVM) Start(ctx context.Context, conf config.Config) error {
    // 设置环境变量
    // LIMA_SSH_PORT_FORWARDER 决定端口转发方式
    l.host = l.host.WithEnv(envSSHPortForwarder + "=" + conf.PortForwarder)

    // 启动 macOS 守护进程
    l.startDaemon(ctx, conf)
```

`startDaemon()` 启动两类可选的后台服务：

1. **vmnet 守护进程**：当用户需要 VM 有可达 IP 地址时（`conf.Network.Address == true`），启动 vmnet 提供桥接网络。vmnet 需要 root 权限，通过预安装的 sudoers 规则实现免密。

2. **inotify 守护进程**：当用户启用了文件挂载的 inotify 事件传播时（`conf.MountINotify == true`），启动一个守护进程监听宿主机文件变化并通知 VM。这解决了 sshfs/9p 不传播文件变更事件的问题。

### 2.2 创建容器数据磁盘

容器的数据（镜像、层、卷）需要持久化存储。Colima 创建一块**独立的虚拟磁盘**：

```go
// environment/vm/lima/disk.go
func (l *limaVM) createRuntimeDisk(conf config.Config) error {
    if environment.IsNoneRuntime(conf.Runtime) {
        return nil  // 不用容器运行时就不需要数据盘
    }

    disk := dataDisk(conf.Runtime)  // 不同运行时有不同的目录需求

    s, _ := store.Load()
    format := !s.DiskFormatted  // 只在首次格式化

    if !limautil.HasDisk() {
        // 创建虚拟磁盘文件
        limautil.CreateDisk(conf.Disk)  // → limactl disk create <name> --size <GiB>
        format = true
    }

    // 安全检查：防止在已格式化给其他运行时的磁盘上切换
    if s.DiskFormatted && s.DiskRuntime != "" && s.DiskRuntime != conf.Runtime {
        return fmt.Errorf("runtime disk provisioned for %s runtime. "+
            "Delete container data with 'colima delete --data' before using another runtime",
            s.DiskRuntime)
    }

    // 将磁盘加入 Lima 配置
    l.limaConf.AdditionalDisks = append(l.limaConf.AdditionalDisks, limaconfig.Disk{
        Name:   config.CurrentProfile().ID,
        Format: format,
        FSType: disk.FSType,  // ext4
    })

    l.mountRuntimeDisk(conf, format)
    return nil
}
```

**不同运行时的目录需求**：

```
Docker:      /var/lib/docker, /var/lib/containerd, /var/lib/rancher, /var/lib/cni, /var/lib/ramalama
Containerd:  /var/lib/containerd, /var/lib/buildkit, /var/lib/nerdctl, /var/lib/rancher, /var/lib/cni
Incus:       /var/lib/incus
```

**磁盘挂载机制**：通过 Lima 的 provision 脚本，在 VM 启动后执行：

```bash
# 检测磁盘设备（/dev/vdb 或 /dev/vdc）
# 首次格式化为 ext4
# 挂载到 /mnt/lima-<profileID>
# 用 bind mount 映射到各运行时目录
mount --bind /mnt/lima-colima/docker /var/lib/docker
mount --bind /mnt/lima-colima/containerd /var/lib/containerd
```

**关键设计**：数据磁盘独立于 VM 的根磁盘。这意味着你可以删除 VM 重建，容器数据还在；也可以用 `colima delete --data` 专门清理数据。

## 三、Phase 2：VM 配置生成

### 3.1 构建 Lima YAML

`newConf()` 将 Colima 的用户配置翻译为 Lima 理解的 YAML 格式：

```go
// environment/vm/lima/yaml.go
func newConf(ctx context.Context, conf config.Config) (l limaconfig.Config, err error) {
    // 1. 架构
    l.Arch = environment.Arch(conf.Arch).Value()  // x86_64 或 aarch64

    // 2. 虚拟化引擎选择（见上一篇）
    l.VMType = limaconfig.QEMU
    // ... VZ/Krunkit 选择逻辑

    // 3. 计算资源
    if conf.CPU > 0 { l.CPUs = &conf.CPU }
    if conf.Memory > 0 { l.Memory = fmt.Sprintf("%dMiB", uint32(conf.Memory*1024)) }
    if conf.RootDisk > 0 { l.Disk = fmt.Sprintf("%dGiB", conf.RootDisk) }

    // 4. DNS
    l.DNS = conf.Network.DNSResolvers
    l.HostResolver.Enabled = len(conf.Network.DNSResolvers) == 0  // 没有自定义 DNS 时启用 Lima 的 host resolver
    l.HostResolver.Hosts["host.docker.internal"] = "host.lima.internal"  // 仅当 key 不存在时设置

    // 5. Provision 脚本（在 VM 内执行的初始化脚本）
    // ... 修复 inotify 限制、设置用户组、主机名等

    // 6. 网络配置
    // ... user-v2、VZNAT、vmnet

    // 7. Socket 转发
    // ... Docker/containerd/incus socket

    // 8. 端口转发
    // ... TCP/UDP 端口范围

    // 9. 文件挂载
    // ... home 目录或自定义挂载点

    // 10. 挂载类型
    // ... virtiofs/9p/sshfs

    return l, nil
}
```

### 3.2 Provision 脚本注入

Colima 向 Lima YAML 注入一系列在 VM 内执行的 shell 脚本。这些脚本按执行时机分为几类：

```go
// 以 "system" 模式注入（VM 首次创建时执行）
l.Provision = append(l.Provision, limaconfig.Provision{
    Mode:   "system",
    Script: `
        # 修复 inotify 限制（Docker/node 需要）
        sysctl -w fs.inotify.max_user_watches=1048576

        # 设置主机名
        hostnamectl set-hostname <hostname>

        # 将用户加入 docker/incus-admin 组
        usermod -aG docker $USER
    `,
})

// 以 "dependency" 模式注入（每次启动时执行）
l.Provision = append(l.Provision, limaconfig.Provision{
    Mode:   "dependency",
    Script: diskMountScript(format),  // 磁盘挂载脚本
})
```

### 3.3 下载 Linux 磁盘镜像

```go
// environment/vm/lima/disk.go
func (l *limaVM) downloadDiskImage(conf config.Config) error {
    // 自定义镜像
    if conf.DiskImage != "" {
        // 验证 SHA512，缓存镜像
        // 支持 qcow2 → raw 转换（如果有 qemu-img）
    }
    // 默认：使用 Lima 内置的 Ubuntu 镜像
}
```

Lima 默认使用 **Ubuntu** 作为 VM 的 Linux 发行版（Colima 的 VM 镜像基于 Ubuntu 构建）。镜像是 qcow2 格式的压缩磁盘文件，包含完整的 Linux 系统（内核 + 用户空间 + systemd + Docker/containerd 预装）。

### 3.4 网络配置写入

```go
// environment/vm/lima/network.go
func (l *limaVM) writeNetworkFile(conf config.Config) error {
    // 写入 ~/.lima/_config/networks.yaml
    // 配置 user-v2 网络（Lima 的用户态网络）
    // 如果有 vmnet，写入 vmnet socket 路径
}
```

## 四、Phase 3：VM 启动引导

### 4.1 limactl start

所有配置准备好后，Colima 调用 Lima 的核心命令：

```go
// environment/vm/lima/lima.go
// 首次创建
host.Run("limactl", "start", "--tty=false", yamlFilePath)

// 恢复已有 VM
host.Run("limactl", "start", profileID)
```

Lima 收到这个命令后：

1. **解析 YAML 配置**
2. **创建 VM 磁盘**（从镜像复制并扩展到指定大小）
3. **生成 cloud-init 配置**（用户、SSH 密钥、网络）
4. **调用虚拟化引擎**（QEMU 命令行 / VZ API / libkrun）
5. **等待 VM 启动**（SSH 端口可达）
6. **执行 provision 脚本**（按顺序在 VM 内执行）

### 4.2 VM 内的 Linux 启动序列

VM 内的 Linux 启动过程因虚拟化引擎而略有不同：

```
QEMU 模式：
  UEFI → GRUB → Linux Kernel → initramfs → systemd
                                                ├── 网络配置 (DHCP)
                                                ├── SSH 服务 (sshd)
                                                ├── cloud-init (用户创建、密钥注入)
                                                └── Lima provision 脚本

VZ 模式：
  Virtualization.framework 直接加载 → Linux Kernel → initramfs → systemd
  （VZ 支持直接引导内核，不需要 GRUB bootloader）      ├── ...
                                                      └── ...
```

无论哪种模式，当 SSH 服务（sshd）就绪后，Lima 就可以通过 SSH 与 VM 通信了。这是后续所有操作（DNS 配置、证书安装、容器运行时启动）的基础。

### 4.3 首次启动 vs 恢复启动

```go
// environment/vm/lima/lima.go:78-132（简化，实际用 action chain 编排）
func (l *limaVM) Start(ctx context.Context, conf config.Config) error {
    l.prepareHost(conf)

    if l.Created() {
        return l.resume(ctx, conf)  // 已创建 → 恢复启动
    }

    // 首次：完整创建流程
    l.startDaemon(ctx, conf)        // vmnet/inotify 守护进程
    l.limaConf = newConf(ctx, conf) // 生成 Lima YAML
    l.assertQemu()                  // 验证 QEMU 可用性
    l.createRuntimeDisk(conf)       // 创建数据磁盘
    l.downloadDiskImage(ctx, conf)  // 下载 Linux 镜像
    l.writeNetworkFile(conf)        // 写入网络配置
    host.Run("limactl", "start", "--tty=false", yamlPath)
    l.addPostStartActions(conf)     // DNS/证书/emulation/网络
    // ...
}

func (l *limaVM) resume(ctx context.Context, conf config.Config) error {
    // 恢复：跳过镜像下载和磁盘格式化
    l.startDaemon(ctx, conf)
    l.syncDiskSize(ctx, conf)       // 检查磁盘是否需要扩容
    l.limaConf = newConf(ctx, conf)
    l.useRuntimeDisk(conf)          // 复用已有磁盘（不重新格式化）
    l.setDiskImage()                // 加载之前保存的镜像信息
    l.writeNetworkFile(conf)
    host.Run("limactl", "start", profileID)  // 恢复已有 VM
    l.addPostStartActions(conf)
    // ...
}
```

恢复启动比首次快得多——不需要下载镜像、不需要格式化磁盘。两者都会执行 `addPostStartActions`（DNS、证书、emulation），确保 VM 状态一致。

## 五、Phase 4：VM 内置备

VM 的 Linux 内核启动后，Colima 通过 SSH 在 VM 内执行一系列后置操作：

### 5.1 DNS 配置

```go
// environment/vm/lima/dns.go
func (l *limaVM) setupDNS(conf config.Config) error {
    // 检测 VM 内是否有 dnsmasq
    // 写入 /etc/dnsmasq.d/01-colima.conf
    // 配置 DNS 映射：
    //   host.docker.internal → 网关 IP
    //   host.lima.internal   → 网关 IP
    //   colima.internal      → VM 内部 IP
    //   <hostname>           → 127.0.0.1
    //
    // 替换 /etc/resolv.conf → nameserver 127.0.0.1
    // 重启 dnsmasq 服务
}
```

这确保了 VM 内的容器可以通过 `host.docker.internal` 访问 macOS 宿主机上的服务。

### 5.2 证书安装

```go
// environment/vm/lima/certs.go
func (l *limaVM) copyCerts() error {
    // 扫描 ~/.docker/certs.d/ 目录
    // 通过 limactl copy 传到 VM 内
    // 安装到 /etc/docker/certs.d/ 和 /etc/ssl/certs/
}
```

如果用户配置了私有 Docker Registry 的证书，这些证书需要在 VM 内也可用。

### 5.3 跨架构 emulation 设置

```go
// environment/vm/lima/lima.go — addPostStartActions
// 根据配置启用跨架构支持

// 方式 1：QEMU binfmt（软件模拟）
// 安装 qemu-user-static，注册 binfmt_misc

// 方式 2：Rosetta 2（VZ 模式下的硬件翻译）
// 已在 Lima YAML 中配置，VM 启动时自动注册
```

### 5.4 宿主机地址复制

```go
// environment/vm/lima/network.go
func (l *limaVM) replicateHostAddresses(conf config.Config) error {
    // 当 network.HostAddresses == true 时
    // 获取宿主机的所有网络接口 IP
    // 将这些 IP 添加到 VM 的 loopback 接口
    // 这样 VM 内的容器可以直接通过宿主机 IP 访问宿主机服务
}
```

### 5.5 状态持久化

```go
// 保存当前配置到 VM 目录，下次恢复时读取
// 标记磁盘已格式化，防止重复格式化
s.DiskFormatted = true
s.DiskRuntime = conf.Runtime
store.Save(s)
```

## 六、Phase 5：容器运行时启动

这一阶段回到 `app.go` 的控制流，在 VM 就绪后安装和启动容器运行时。（详见下一篇文章）

```go
// app/app.go
for _, cont := range containers {
    cont.Provision(ctx)  // 安装配置
    cont.Start(ctx)      // 启动服务
}
```

## 七、完整时序图

```
时间 →

用户                Colima App          Lima/VM              VM 内部
 │                    │                   │                    │
 │ colima start       │                   │                    │
 │───────────────────►│                   │                    │
 │                    │                   │                    │
 │                    │ startDaemon()     │                    │
 │                    │ (vmnet/inotify)   │                    │
 │                    │                   │                    │
 │                    │ newConf()         │                    │
 │                    │ (生成 Lima YAML)  │                    │
 │                    │                   │                    │
 │                    │ createDisk()      │                    │
 │                    │ downloadImage()   │                    │
 │                    │                   │                    │
 │                    │ limactl start     │                    │
 │                    │──────────────────►│                    │
 │                    │                   │ 创建 VM 磁盘       │
 │                    │                   │ 启动虚拟化引擎     │
 │                    │                   │                    │
 │                    │                   │                ┌───┴──────┐
 │                    │                   │                │ UEFI     │
 │                    │                   │                │ Kernel   │
 │                    │                   │                │ systemd  │
 │                    │                   │                │ sshd ✓   │
 │                    │                   │                └───┬──────┘
 │                    │                   │                    │
 │                    │                   │ SSH 就绪            │
 │                    │                   │◄───────────────────│
 │                    │                   │                    │
 │                    │                   │ provision 脚本     │
 │                    │                   │───────────────────►│
 │                    │                   │                    │ 磁盘挂载
 │                    │                   │                    │ inotify
 │                    │                   │                    │ 用户组
 │                    │                   │                    │
 │                    │ VM 就绪           │                    │
 │                    │◄──────────────────│                    │
 │                    │                   │                    │
 │                    │ setupDNS()        │                    │
 │                    │──────────────────────────────────────►│ dnsmasq
 │                    │ copyCerts()       │                    │
 │                    │──────────────────────────────────────►│ 证书安装
 │                    │ emulation()       │                    │
 │                    │──────────────────────────────────────►│ binfmt
 │                    │                   │                    │
 │                    │ Provision()       │                    │
 │                    │──────────────────────────────────────►│ 安装 Docker
 │                    │ Start()           │                    │
 │                    │──────────────────────────────────────►│ 启动 dockerd
 │                    │                   │                    │
 │ 就绪 ✓            │                   │                    │
 │◄───────────────────│                   │                    │
```

## 八、磁盘架构

一个 Colima 实例涉及多块虚拟磁盘：

```
┌────────────────────────────────────────────────────┐
│                    VM 磁盘布局                       │
│                                                    │
│  ┌────────────────────────┐                        │
│  │  根磁盘 (rootDisk)      │ ← 默认 20 GiB        │
│  │  /                      │                       │
│  │  ├── /usr/bin/          │   Docker/containerd   │
│  │  ├── /etc/              │   配置文件            │
│  │  ├── /home/             │   用户目录            │
│  │  └── ...                │                       │
│  └────────────────────────┘                        │
│                                                    │
│  ┌────────────────────────┐                        │
│  │  数据磁盘 (dataDisk)    │ ← 默认 100 GiB       │
│  │  /mnt/lima-colima/      │                       │
│  │  ├── docker/       ──bind──→ /var/lib/docker   │
│  │  ├── containerd/   ──bind──→ /var/lib/containerd│
│  │  ├── rancher/      ──bind──→ /var/lib/rancher  │
│  │  └── cni/          ──bind──→ /var/lib/cni      │
│  └────────────────────────┘                        │
│                                                    │
│  ┌────────────────────────┐                        │
│  │  cidata (cloud-init)    │ ← 只读               │
│  │  SSH 公钥               │                       │
│  │  用户配置               │                       │
│  └────────────────────────┘                        │
└────────────────────────────────────────────────────┘
```

**根磁盘和数据磁盘分离的意义**：
- 重建 VM 时不丢失容器数据
- 可以独立调整两块磁盘的大小
- 可以只清理容器数据而保留 VM

## 九、Profile 多实例

Colima 支持同时运行多个独立的 VM 实例：

```go
// config/profile.go
type Profile struct {
    ID          string  // "colima" 或 "colima-<name>"
    DisplayName string
    ShortName   string  // "default" 或 "<name>"
}
```

每个 Profile 有独立的：
- Lima VM 实例
- 数据磁盘
- 配置文件
- Socket 文件
- Docker context

```bash
colima start                    # 默认 profile
colima start --profile dev      # "dev" profile
colima start --profile staging  # "staging" profile

# 三个独立的 Linux VM 同时运行
```

## 十、小结

整个 VM 生命周期的核心设计原则：

1. **声明式配置**：用户描述"我要什么"（CPU/内存/运行时），Colima 翻译成 Lima YAML
2. **分层磁盘**：根磁盘和数据磁盘分离，生命周期独立
3. **幂等 provision**：通过 Lima 的 provision mode（system/dependency）控制脚本执行时机
4. **首次/恢复 分离**：恢复启动跳过下载和格式化，大幅提速
5. **多实例隔离**：Profile 机制支持多个完全独立的容器环境

下一篇将深入 **VM 内部的容器运行时**——Docker daemon 和 containerd 如何在 VM 内被安装、配置和启动。
