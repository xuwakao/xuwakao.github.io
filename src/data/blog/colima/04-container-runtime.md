---
title: "Colima运行linux容器（四）：VM 内的容器运行时"
description: "分析 VM 内 containerd 和 Docker 的启动流程以及容器运行时的分层架构"
pubDatetime: 2025-02-03T00:00:00Z
modDatetime: 2025-02-03T00:00:00Z
author: "xuwakao"
slug: "linux-container-runtime"
tags:
  - container
  - linux
  - colima
  - docker
  - containerd
featured: false
---

# Colima运行linux容器（四）：VM 内的容器运行时

> 基于 Colima 源码深度分析

## 一、VM 内的软件栈

当 Linux VM 启动后，它是一个预装了 Docker 和 containerd 的 Ubuntu 系统（Colima 的 VM 镜像已内置这些二进制）。但仅仅有二进制还不够，需要**正确配置并启动**这些运行时。Colima 支持三种主要运行时：

```
┌────────────────────────────────────────────────────┐
│                    Linux VM 内部                     │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │              选择一个运行时                     │  │
│  │                                              │  │
│  │  Docker              containerd      Incus   │  │
│  │  ┌──────────┐       ┌──────────┐    ┌─────┐  │  │
│  │  │ dockerd  │       │containerd│    │incusd│  │  │
│  │  │    │     │       │    │     │    │     │  │  │
│  │  │    ▼     │       │    ▼     │    │ ZFS │  │  │
│  │  │containerd│       │  runc   │    │     │  │  │
│  │  │    │     │       └─────────┘    └─────┘  │  │
│  │  │    ▼     │                                │  │
│  │  │  runc    │  ← 所有路径最终都走 Linux 内核   │  │
│  │  └─────────┘                                 │  │
│  └──────────────────────────────────────────────┘  │
│                        │                           │
│  ┌─────────────────────▼────────────────────────┐  │
│  │             Linux Kernel                      │  │
│  │  namespaces · cgroups · overlayfs · netns     │  │
│  └───────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

无论选择哪个运行时，容器隔离最终都依赖 Linux 内核的 namespaces 和 cgroups。运行时的区别在于**管理层的能力和接口**。

## 二、Docker 运行时——最常用的路径

### 2.1 Docker 的内部架构

在 Colima 中，Docker 运行时实际上是一个**三层栈**：

```
docker CLI (macOS) ──socket──→ dockerd (VM) ──→ containerd (VM) ──→ runc ──→ Linux Kernel
```

- **dockerd**：Docker 守护进程，提供 Docker API（构建、拉取、网络、卷管理）
- **containerd**：底层容器运行时，管理容器生命周期和镜像存储
- **runc**：OCI 运行时，直接调用 Linux 内核创建 namespaces/cgroups

### 2.2 Provision — 安装配置

```go
// environment/container/docker/docker.go:47-77（简化）
func (d dockerRuntime) Provision(ctx context.Context) error {
    // 第一步：安装配置 containerd（Docker 的依赖）
    d.provisionContainerd(ctx)

    // 第二步：配置 Docker daemon（以下错误不中断流程，仅告警）
    d.createDaemonFile(conf.Docker, conf.Env)   // 写 daemon.json
    d.addHostGateway(conf.Docker)               // 写 systemd override
    d.reloadAndRestartSystemdService()          // daemon-reload + restart docker

    // 第三步：在 macOS 上创建 Docker context
    d.setupContext()

    // 第四步：激活 context（如果启用了自动激活）
    if conf.AutoActivate() {
        d.useContext()
    }
}
```

注意第二步的三个操作即使失败也只打印警告、不中断启动——这是一个容错设计，避免因配置细节问题导致整体启动失败。

#### 第一步：containerd 配置

```go
// environment/container/docker/containerd.go
func (d dockerRuntime) provisionContainerd() error {
    // 备份 VM 内原有的 containerd 配置
    guest.Run("sudo", "cp", "/etc/containerd/config.toml",
        "/etc/containerd/config.colima.bak.toml")

    // 写入 Colima 的 containerd 配置（嵌入在二进制中的模板）
    guest.Write("/etc/containerd/config.toml", embeddedConfig)

    // 重启 containerd 服务
    systemctl.Restart("containerd.service")
}
```

#### 第二步：daemon.json

```go
// environment/container/docker/daemon.go
func (d dockerRuntime) createDaemonFile(conf config.Config) error {
    // 基础配置
    daemonConf := map[string]any{
        "features": map[string]bool{
            "buildkit":                true,   // 启用 BuildKit
            "containerd-snapshotter": true,    // 使用 containerd 快照器
        },
    }

    // 如果用了 Kubernetes，设置 cgroupfs（k3s 需要）
    if conf.Kubernetes.Enabled {
        daemonConf["exec-opts"] = []string{"native.cgroupdriver=cgroupfs"}
    }

    // 合并用户自定义配置
    for k, v := range conf.Docker {
        daemonConf[k] = v
    }

    // 处理代理：localhost 代理需要转换为 host gateway IP
    d.handleProxy(daemonConf)

    // 写入 /etc/docker/daemon.json
    guest.Write("/etc/docker/daemon.json", marshal(daemonConf))
}
```

**代理处理**：

```go
// environment/container/docker/proxy.go
func (d dockerRuntime) handleProxy(conf map[string]any) {
    // 用户可能设置了 "proxies": {"http-proxy": "http://localhost:7890"}
    // 但容器内的 localhost 是容器自己，不是宿主机
    // 需要将 localhost/127.0.0.1 替换为 host gateway IP
    // 这样容器才能通过代理访问网络
}
```

#### host gateway 配置

```go
// daemon.go
const systemdUnitFilename = "/etc/systemd/system/docker.service.d/docker.conf"
const systemdUnitFileContent = `
[Service]
LimitNOFILE=infinity
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock --host-gateway-ip=%s
`

func (d dockerRuntime) addHostGateway(conf map[string]any) error {
    // 获取 host gateway IP（从 /etc/hosts 中查找 host.lima.internal）
    hostGatewayIP := getHostGatewayIp()

    // 写入 systemd override 文件
    unitFile := fmt.Sprintf(systemdUnitFileContent, hostGatewayIP)
    guest.Write(systemdUnitFilename, unitFile)
}

func (d dockerRuntime) reloadAndRestartSystemdService() error {
    d.systemctl.DaemonReload()         // systemctl daemon-reload
    d.systemctl.Restart("docker.service")  // systemctl restart docker
}
```

`--host-gateway-ip` 参数告诉 Docker：当容器使用 `host-gateway` 作为 extra_hosts 时，解析为这个 IP。这是 `docker run --add-host=host.docker.internal:host-gateway` 能工作的基础。

#### Docker Context

```go
// environment/container/docker/context.go
func (d dockerRuntime) setupContext() error {
    // 在 macOS 上执行：
    host.Run("docker", "context", "create", profileID,
        "--description", profileDisplayName,
        "--docker", "host=unix://"+HostSocketFile())
    // HostSocketFile() → ~/.colima/<profile>/docker.sock
}
```

这是**桥接层的关键**——在 macOS 上创建一个 Docker context，指向 Lima 转发的 Unix socket。

### 2.3 Start — 启动 Docker

```go
// environment/container/docker/docker.go:82-105
func (d dockerRuntime) Start(ctx context.Context) error {
    // 重试启动 Docker 服务（最多 60 次，每次间隔 1 秒）
    a.Retry("", time.Second, 60, func(int) error {
        return d.systemctl.Start("docker.service")
    })

    // 等待 Docker 就绪（最多 60 秒）
    a.Retry("", time.Second, 60, func(int) error {
        return d.guest.RunQuiet("sudo", "docker", "info")
    })

    // 验证非 root 用户也能访问 Docker
    a.Add(func() error {
        if d.guest.RunQuiet("docker", "info") == nil {
            return nil  // 已经可以无 sudo 访问
        }
        // 用户可能还没生效进 docker 组，重启整个 VM 使组变更生效
        return d.guest.Restart(ctx)
    })

    return a.Exec()
}
```

**重试机制**：Docker daemon 启动需要时间（加载镜像层、初始化网络），用 `Retry` 包装了最多 60 次 × 1 秒的重试。注意非 root 检查失败时是**重启 VM**（不仅仅是重启 Docker 服务），因为 Linux 用户组变更需要重新登录才能生效。

### 2.4 数据磁盘目录

```go
// environment/container/docker/docker.go
var diskDirs = []environment.DiskDir{
    {Name: "docker",     Path: "/var/lib/docker"},
    {Name: "containerd", Path: "/var/lib/containerd"},
    {Name: "rancher",    Path: "/var/lib/rancher"},   // k3s 数据
    {Name: "cni",        Path: "/var/lib/cni"},
    {Name: "ramalama",   Path: "/var/lib/ramalama"},  // AI 模型
}

func DataDisk() environment.DataDisk {
    return environment.DataDisk{
        Dirs:   diskDirs,
        FSType: "ext4",
        PreMount: []string{
            "systemctl stop docker.service",      // 挂载前先停服务
            "systemctl stop containerd.service",
        },
    }
}
```

所有容器镜像、层、卷数据都存在数据磁盘的 bind mount 目录中，与 VM 根文件系统隔离。

## 三、containerd 运行时——无 Docker 的轻量路径

### 3.1 与 Docker 模式的区别

选择 containerd 运行时意味着：
- **没有** Docker daemon
- 用 **nerdctl** 代替 docker CLI
- 用 **BuildKit** 作为构建引擎
- 更接近 Kubernetes 使用的底层运行时

```
nerdctl (macOS) ──socket──→ containerd (VM) ──→ runc ──→ Linux Kernel
                            BuildKit (VM) ──→ 构建镜像
```

### 3.2 三级配置覆盖

containerd 模式实现了**三级配置查找**：

```go
// environment/container/containerd/containerd.go
func (c containerdRuntime) resolveConfig(configFile string, embeddedDefault []byte) ([]byte, error) {
    // 优先级 1：Profile 级覆盖
    // ~/.colima/<profile>/containerd/config.toml
    profileConfig := filepath.Join(profileDir, configFile)
    if data, err := host.Read(profileConfig); err == nil {
        return []byte(data), nil
    }

    // 优先级 2：全局用户配置
    // ~/.config/containerd/config.toml (XDG_CONFIG_HOME)
    centralConfig := filepath.Join(configHome, "containerd", configFile)
    if data, err := host.Read(centralConfig); err == nil {
        return []byte(data), nil
    }

    // 优先级 3：嵌入的默认配置
    // 首次运行时写到全局位置，方便用户发现和修改
    host.Write(centralConfig, embeddedDefault)
    return embeddedDefault, nil
}
```

### 3.3 Provision 和 Start

```go
func (c containerdRuntime) Provision(ctx context.Context) error {
    // 解析并写入 containerd 配置
    config := c.resolveConfig("config.toml", embeddedConfigToml)
    guest.Write("/etc/containerd/config.toml", config)

    // 解析并写入 BuildKit 配置
    bkConfig := c.resolveConfig("buildkitd.toml", embeddedBuildkitdToml)
    guest.Write("/etc/buildkit/buildkitd.toml", bkConfig)
}

// environment/container/containerd/containerd.go:137-154
func (c containerdRuntime) Start(ctx context.Context) error {
    // 重启 containerd
    c.systemctl.Restart("containerd.service")

    // 等待 nerdctl info 成功（最多 10 次，每次间隔 5 秒）
    a.Retry("", time.Second*5, 10, func(int) error {
        return c.guest.RunQuiet("sudo", "nerdctl", "info")
    })

    // 启动 BuildKit
    c.systemctl.Start("buildkit.service")
}
```

### 3.4 数据磁盘目录

```go
// environment/container/containerd/containerd.go
var diskDirs = []environment.DiskDir{
    {Name: "containerd", Path: "/var/lib/containerd"},
    {Name: "buildkit",   Path: "/var/lib/buildkit"},
    {Name: "nerdctl",    Path: "/var/lib/nerdctl"},
    {Name: "rancher",    Path: "/var/lib/rancher"},
    {Name: "cni",        Path: "/var/lib/cni"},
}

func DataDisk() environment.DataDisk {
    return environment.DataDisk{
        Dirs:   diskDirs,
        FSType: "ext4",
        PreMount: []string{
            "systemctl stop containerd.service",
            "systemctl stop buildkit.service",
        },
    }
}
```

## 四、Kubernetes (K3s) — 在 VM 内的集群

### 4.1 K3s 是什么

K3s 是 Rancher 推出的轻量 Kubernetes 发行版，单个二进制文件包含完整的 K8s 控制面和工作节点。Colima 在 VM 内部署 K3s 来提供 Kubernetes 能力。

```
kubectl (macOS) ──kubeconfig──→ K3s API Server (VM:6443)
                                    │
                                    ▼
                              K3s Agent (VM)
                                    │
                              ┌─────┴─────┐
                              │           │
                          containerd    Docker
                          (CRI)         (CRI)
                              │           │
                              └─────┬─────┘
                                    │
                                  runc
                                    │
                              Linux Kernel
```

### 4.2 安装流程

```go
// environment/container/kubernetes/k3s.go
func (k k3sInstaller) install(version string) error {
    arch := guest.Arch()

    // 1. 下载 k3s 二进制文件
    k3sURL := fmt.Sprintf(
        "https://github.com/k3s-io/k3s/releases/download/%s/k3s", version)
    if arch == "aarch64" {
        k3sURL += "-arm64"  // ARM 架构用不同的二进制
    }
    // 验证 SHA256
    // 安装到 /usr/local/bin/k3s

    // 2. 下载离线镜像包
    imagesURL := fmt.Sprintf(
        "https://github.com/k3s-io/k3s/releases/download/%s/"+
        "k3s-airgap-images-%s.tar.gz", version, archName)
    // 解压到 /var/lib/rancher/k3s/agent/images/
    // 预加载到容器运行时（避免启动时从网络拉取）

    // 3. 下载并执行安装脚本
    // INSTALL_K3S_SKIP_DOWNLOAD=true  — 已手动安装了二进制
    // INSTALL_K3S_SKIP_ENABLE=true    — 不自动启用服务（由 Colima 控制）
    guest.Run("INSTALL_K3S_SKIP_DOWNLOAD=true",
        "INSTALL_K3S_SKIP_ENABLE=true",
        "/tmp/k3s-install.sh", k3sArgs...)
}
```

### 4.3 K3s 启动参数

```go
func (k k3sInstaller) k3sArgs() []string {
    args := []string{
        "--write-kubeconfig-mode", "644",  // kubeconfig 文件权限
    }

    // 根据容器运行时选择 CRI
    switch runtime {
    case "docker":
        args = append(args, "--docker")
    case "containerd":
        args = append(args,
            "--container-runtime-endpoint",
            "unix:///run/containerd/containerd.sock")
    }

    // 网络配置
    args = append(args, "--flannel-iface", "eth0")

    // 如果 VM 有可达 IP，设置 advertise address
    if vmIP != "127.0.0.1" {
        args = append(args, "--advertise-address", vmIP)
    }

    return args
}
```

### 4.4 kubeconfig 管理

K3s 启动后，需要把 kubeconfig 从 VM 内拿出来供 macOS 上的 kubectl 使用：

```go
// environment/container/kubernetes/kubeconfig.go
func (k k8s) provisionKubeconfig() error {
    // 1. 从 VM 读取 /etc/rancher/k3s/k3s.yaml
    kubeconfig := guest.RunOutput("sudo", "cat", "/etc/rancher/k3s/k3s.yaml")

    // 2. 替换集群名和 IP
    //    default → colima（或 profile 名）
    //    127.0.0.1 → VM 的实际 IP

    // 3. 与宿主机现有的 ~/.kube/config 合并
    //    使用 kubectl config view --raw 做非破坏性合并

    // 4. 备份原有 kubeconfig，写入合并后的版本

    // 5. 设置当前 context（如果启用了自动激活）
    host.Run("kubectl", "config", "use-context", profileID)
}
```

## 五、Incus — 系统容器运行时

Incus（LXD 的社区 fork）提供了一种不同的容器化方式——**系统容器**（完整的 Linux 发行版）和 **轻量 VM**。

```go
// environment/container/incus/incus.go
func (i incusRuntime) Provision(ctx context.Context) error {
    // 使用嵌入的 YAML 配置做 preseed 初始化
    // 配置 ZFS 存储池、桥接网络
    guest.Run("sudo", "incus", "admin", "init", "--preseed")

    // 在宿主机上添加 Incus remote
    host.Run("incus", "remote", "add", profileID,
        "unix://"+socketFile)

    // 添加 Docker Hub 作为 OCI remote
    host.Run("incus", "remote", "add", "docker",
        "https://docker.io", "--protocol=oci")
}
```

Incus 的独特之处在于网络——它用桥接网络给每个容器分配独立 IP：

```go
// environment/container/incus/route.go
func (i incusRuntime) addRoute() error {
    // 在 macOS 上添加路由，让宿主机能直接访问 Incus 容器
    // sudo route add -net 192.168.100.0/24 <vm_ip>
    host.Run("sudo", "route", "add", "-net",
        subnetCIDR, vmIPAddress)
}
```

## 六、systemctl — VM 内的服务管理

所有运行时最终都通过 systemd 管理服务：

```go
// environment/guest/systemctl/systemctl.go
type Systemctl struct {
    runner Runner  // GuestActions — 通过 SSH 在 VM 内执行
}

func (s Systemctl) Start(service string) error {
    return s.runner.Run("sudo", "systemctl", "start", service)
}

func (s Systemctl) Restart(service string) error {
    return s.runner.Run("sudo", "systemctl", "restart", service)
}

func (s Systemctl) Stop(service string, force bool) error {
    action := "stop"
    if force { action = "kill" }
    return s.runner.Run("sudo", "systemctl", action, service)
}

func (s Systemctl) Active(service string) bool {
    return s.runner.RunQuiet("systemctl", "is-active", service) == nil
}
```

各运行时使用的 systemd 服务：

| 运行时 | 服务 |
|-------|------|
| Docker | `docker.service`, `containerd.service` |
| containerd | `containerd.service`, `buildkit.service` |
| Kubernetes | `k3s.service` |
| Incus | `incus.service`, `incus.socket` |

## 七、停止和清理

### Stop — 优雅停止

```go
// app/app.go
func (c colimaApp) Stop(force bool) error {
    // 反序停止容器运行时
    for i := len(containers) - 1; i >= 0; i-- {
        containers[i].Stop(ctx, force)
    }
    // 停止 VM
    c.guest.Stop(ctx, force)
}
```

**反序停止**：Kubernetes 先停（它依赖 Docker/containerd），然后 Docker/containerd，最后 VM。

### Delete — 彻底删除

```go
func (c colimaApp) Delete(data, force bool) error {
    // Teardown 各运行时（卸载配置）
    for _, cont := range containers {
        cont.Teardown(ctx)
    }
    // 删除 VM
    c.guest.Teardown(ctx)  // → limactl delete --force <profileID>

    // 可选：删除数据磁盘
    if data {
        limautil.DeleteDisk()
    }
}
```

## 八、小结

容器运行时安装的本质是：**通过 SSH 在 Linux VM 内执行一系列配置脚本和 systemd 操作**。

```
Colima 做的事：
1. 用 Go 代码生成配置文件（daemon.json, config.toml, ...）
2. 通过 SSH 写入 VM 内的 /etc/ 目录
3. 通过 SSH 调用 systemctl 启动/重启服务
4. 等待服务就绪（重试循环）
5. 在宿主机上创建 context/kubeconfig

Lima 做的事：
1. 提供 SSH 通道
2. 转发 Socket（docker.sock, containerd.sock）
3. 转发端口（TCP/UDP 1-65535）
4. 挂载文件系统
```

运行时本身（Docker、containerd、runc）不需要任何修改——它们运行在真正的 Linux 内核上，和裸机 Linux 上的行为完全一致。Colima 的工作只是**自动化了安装和桥接过程**。

下一篇（最后一篇）将分析最关键的透明化层——**宿主机和 VM 之间的桥接**，包括 Socket 转发、端口映射、文件系统挂载和网络架构。
