---
title: "Waydroid 源码分析（五）：网络架构与设备直通"
description: "分析 Waydroid 的网络架构设计和设备直通机制，包括虚拟网桥、NAT 转发和硬件设备映射"
pubDatetime: 2021-06-03T00:00:00Z
modDatetime: 2021-06-03T00:00:00Z
author: "xuwakao"
slug: "waydroid-networking"
tags:
  - android
  - linux
  - waydroid
  - networking
  - passthrough
featured: false
---
# Waydroid 源码分析（五）：网络架构与设备直通

> 本文分析 Waydroid 的网络栈实现——包括 waydroid0 网桥创建、NAT 规则配置、DHCP 服务、ADB 连接机制，以及 GPU、摄像头、Binder 等设备的容器直通策略。

## 一、网络架构

### 网络拓扑

```
互联网
  ↕
宿主机物理网卡 (wlan0/eth0)
  ↕  iptables/nftables MASQUERADE
waydroid0 网桥 (192.168.240.1/24)
  ↕  veth pair
容器内 eth0 (DHCP 分配: 192.168.240.2-254)
```

### waydroid-net.sh：网络启动脚本

`data/scripts/waydroid-net.sh` 是一个自包含的 shell 脚本，负责容器网络的完整生命周期。

**网络参数配置**：

```bash
LXC_BRIDGE="waydroid0"
LXC_BRIDGE_MAC="00:16:3e:00:00:01"
LXC_ADDR="192.168.240.1"
LXC_NETMASK="255.255.255.0"
LXC_NETWORK="192.168.240.0/24"
LXC_DHCP_RANGE="192.168.240.2,192.168.240.254"
LXC_DHCP_MAX="253"
LXC_USE_NFT="false"
```

脚本首先从 LXC 配置中读取网桥名称，确保与容器配置一致：

```bash
net_link_key="lxc.net.0.link"
case "$(lxc-info --version)" in [012].*) net_link_key="lxc.network.link" ;; esac
vnic=$(awk "\$1 == \"$net_link_key\" {print \$3}" /var/lib/waydroid/lxc/waydroid/config)
: ${vnic:=waydroid0}
```

LXC v1/v2 使用 `lxc.network.link`，v3+ 使用 `lxc.net.0.link`。脚本兼容两种版本。

### 网桥创建与 IP 配置

```bash
start() {
    # 防止重复启动
    [ ! -f "${varrun}/network_up" ] || { echo "waydroid-net is already running"; exit 0; }

    # 创建网桥
    [ ! -d /sys/class/net/${LXC_BRIDGE} ] && ip link add dev ${LXC_BRIDGE} type bridge

    # 启用 IPv4 转发
    echo 1 > /proc/sys/net/ipv4/ip_forward

    # 禁用 IPv6 DAD（避免延迟）
    echo 0 > /proc/sys/net/ipv6/conf/${LXC_BRIDGE}/accept_dad || true

    # 配置 IP 地址
    _ifup  # → ip addr add 192.168.240.1/24 broadcast + dev waydroid0
           # → ip link set dev waydroid0 address 00:16:3e:00:00:01
           # → ip link set dev waydroid0 up
}
```

### iptables 规则

```bash
start_iptables() {
    # 允许 DHCP 和 DNS 流量进入
    $IPTABLES_BIN -I INPUT -i ${LXC_BRIDGE} -p udp --dport 67 -j ACCEPT  # DHCP
    $IPTABLES_BIN -I INPUT -i ${LXC_BRIDGE} -p tcp --dport 67 -j ACCEPT
    $IPTABLES_BIN -I INPUT -i ${LXC_BRIDGE} -p udp --dport 53 -j ACCEPT  # DNS
    $IPTABLES_BIN -I INPUT -i ${LXC_BRIDGE} -p tcp --dport 53 -j ACCEPT

    # 允许双向转发
    $IPTABLES_BIN -I FORWARD -i ${LXC_BRIDGE} -j ACCEPT
    $IPTABLES_BIN -I FORWARD -o ${LXC_BRIDGE} -j ACCEPT

    # NAT：容器流量伪装为宿主机 IP
    $IPTABLES_BIN -t nat -A POSTROUTING \
        -s ${LXC_NETWORK} ! -d ${LXC_NETWORK} -j MASQUERADE

    # DHCP 响应的 UDP checksum 修复
    $IPTABLES_BIN -t mangle -A POSTROUTING \
        -o ${LXC_BRIDGE} -p udp -m udp --dport 68 \
        -j CHECKSUM --checksum-fill
}
```

最后一条 `CHECKSUM --checksum-fill` 规则修复了一个已知问题：某些虚拟化环境下 DHCP 响应的 UDP 校验和可能不正确。

### nftables 规则

脚本同时支持 iptables 和 nftables：

```bash
start_nftables() {
    NFT_RULESET="
add table inet lxc;
flush table inet lxc;
add chain inet lxc input { type filter hook input priority 0; };
add rule inet lxc input iifname ${LXC_BRIDGE} udp dport { 53, 67 } accept;
add rule inet lxc input iifname ${LXC_BRIDGE} tcp dport { 53, 67 } accept;
add chain inet lxc forward { type filter hook forward priority 0; };
add rule inet lxc forward iifname ${LXC_BRIDGE} accept;
add rule inet lxc forward oifname ${LXC_BRIDGE} accept;
add table ip lxc;
flush table ip lxc;
add chain ip lxc postrouting { type nat hook postrouting priority 100; };
add rule ip lxc postrouting ip saddr ${LXC_NETWORK} ip daddr != ${LXC_NETWORK} counter masquerade"
    nft "${NFT_RULESET}"
}
```

选择逻辑：

```bash
if use_nft; then
    start_nftables
else
    start_iptables
fi
```

`use_nft()` 检查三个条件：nft 命令存在、nft 可以列出规则集、`LXC_USE_NFT` 设为 true。

### DHCP 服务

```bash
# 选择 dnsmasq 运行用户（安全最小权限）
for DNSMASQ_USER in lxc-dnsmasq dnsmasq nobody; do
    if getent passwd ${DNSMASQ_USER} >/dev/null; then
        break
    fi
done

dnsmasq $LXC_DHCP_CONFILE_ARG \
    -u ${DNSMASQ_USER} \
    --strict-order \
    --bind-interfaces \
    --pid-file="${varrun}"/dnsmasq.pid \
    --listen-address ${LXC_ADDR} \               # 只监听网桥 IP
    --dhcp-range ${LXC_DHCP_RANGE} \              # 192.168.240.2-254
    --dhcp-lease-max=${LXC_DHCP_MAX} \            # 最多 253 个租约
    --dhcp-no-override \
    --except-interface=lo \
    --interface=${LXC_BRIDGE} \
    --dhcp-leasefile="${varlib}"/misc/dnsmasq.${LXC_BRIDGE}.leases \
    --dhcp-authoritative \
    --conf-file=/dev/null                         # 不读取系统 dnsmasq.conf
```

`--conf-file=/dev/null` 确保 dnsmasq 不会读取 `/etc/dnsmasq.conf`，避免与宿主机的 dnsmasq 配置冲突。

### 网络清理

```bash
stop() {
    _ifdown                                        # 清除 IP、关闭接口
    stop_iptables / stop_nftables                  # 删除防火墙规则
    kill -9 $(cat "${varrun}"/dnsmasq.pid)         # 停止 dnsmasq

    # 仅当网桥无附加接口时删除
    ls /sys/class/net/${LXC_BRIDGE}/brif/* > /dev/null 2>&1 \
        || ip link delete ${LXC_BRIDGE}

    rm -f "${varrun}"/network_up
}
```

### LXC 网络配置

容器端的网络配置在 `config_3` 中定义：

```ini
lxc.net.0.type = veth           # 虚拟以太网对
lxc.net.0.flags = up            # 启动时自动 up
lxc.net.0.link = waydroid0      # 连接到 waydroid0 网桥
lxc.net.0.name = eth0           # 容器内名称
lxc.net.0.hwaddr = 00:16:3e:f9:d3:03  # 固定 MAC
lxc.net.0.mtu = 1500
```

LXC 自动创建 veth pair，一端放入容器（名为 `eth0`），另一端连接到 `waydroid0` 网桥。

### ADB 连接

`tools/helpers/net.py` 提供 ADB 连接功能：

```python
def adb_connect(args):
    if not which("adb"):
        raise RuntimeError("Could not find adb")
    tools.helpers.run.user(args, ["adb", "start-server"])
    ip = get_device_ip_address()
    tools.helpers.run.user(args, ["adb", "connect", ip])

def get_device_ip_address():
    lease_file = "/var/lib/misc/dnsmasq.waydroid0.leases"
    try:
        with open(lease_file) as f:
            return re.search(r"(\d{1,3}\.){3}\d{1,3}\s", f.read()).group().strip()
    except:
        pass
```

IP 地址通过解析 dnsmasq 的租约文件获取——简单但可靠。

---

## 二、设备直通

### 设备节点分类

回顾 `generate_nodes_lxc_config()`（`tools/helpers/lxc.py:38`），Waydroid 透传的设备分为以下几类：

**基础设备**（容器运行必需）：

| 设备 | 用途 |
|------|------|
| `/dev/zero`, `/dev/null`, `/dev/full` | 标准 Unix 设备 |
| `/dev/ashmem` | Android 共享内存 |
| `/dev/fuse` | FUSE 文件系统 |
| `/dev/ion` | ION 内存分配器（旧 Android） |
| `/dev/tty` | 终端 |

**GPU 设备**（图形渲染核心）：

| 设备 | GPU 类型 |
|------|----------|
| `/dev/dri/renderD*` | 通用 DRM 渲染节点 |
| `/dev/kgsl-3d0` | Qualcomm Adreno |
| `/dev/mali0` | ARM Mali |
| `/dev/pvr_sync` | PowerVR |
| `/dev/dxg` | NVIDIA (WSL2) |
| `/dev/fb*` | 帧缓冲 |

**媒体设备**：

| 设备 | 用途 |
|------|------|
| `/dev/video*` | V4L2 摄像头/编解码器 |
| `/dev/dma_heap/*` | DMA-BUF 堆 |
| `/dev/Vcodec`, `/dev/MTK_SMI` | Mediatek 视频引擎 |

**Binder 设备**（Android IPC）：

```python
make_entry("/dev/" + args.BINDER_DRIVER, "dev/binder", check=False)
make_entry("/dev/" + args.VNDBINDER_DRIVER, "dev/vndbinder", check=False)
make_entry("/dev/" + args.HWBINDER_DRIVER, "dev/hwbinder", check=False)
```

宿主机设备名（如 `anbox-binder`）映射为容器内标准名（`binder`）。

**VPN 支持**：

```python
make_entry("/dev/net/tun", "dev/tun")
```

**传感器**：

```python
make_entry("/sys/class/leds/vibrator", options="bind,create=dir,optional 0 0")
make_entry("/sys/devices/virtual/timed_output/vibrator", options="bind,create=dir,optional 0 0")
```

振动器通过 sysfs 暴露给容器。

### HALIUM 环境的额外设备

HALIUM 环境下，宿主机本身有 Android HAL 层，需要额外处理：

```python
if args.vendor_type != "MAINLINE":
    # 挂载宿主机的 hwbinder 到容器的 host_hwbinder
    if not make_entry("/dev/hwbinder", "dev/host_hwbinder"):
        raise OSError('Binder node "hwbinder" of host not found')
    # 挂载宿主机的 /vendor 到 vendor_extra（供 HAL 访问）
    make_entry("/vendor", "vendor_extra", options="rbind,optional 0 0")
```

### GPU 检测与 NVIDIA 排除

```python
# gpu.py
unsupported = ["nvidia"]

def getDriNode(args):
    for node in sorted(glob.glob("/dev/dri/renderD*")):
        renderDev = os.path.basename(node)
        if getKernelDriver(args, renderDev) not in unsupported:
            return node, getCardFromRender(args, renderDev)
    return "", ""
```

NVIDIA 的专有驱动不支持 GBM（它使用自己的 EGLStreams），因此被排除。NVIDIA 用户需要使用 nouveau 开源驱动或等待 NVIDIA 的 GBM 支持成熟。

### 权限设置

设备透传后，权限是另一个关键问题：

```python
def set_permissions(args, perm_list=None, mode="777"):
    if not perm_list:
        perm_list = [
            "/dev/ashmem", "/dev/sw_sync",
            "/dev/graphics", "/dev/pvr_sync", "/dev/ion",
        ]
        perm_list.extend(glob.glob("/dev/dri/renderD*"))
        perm_list.extend(glob.glob("/dev/fb*"))
        perm_list.extend(glob.glob("/dev/video*"))
        perm_list.extend(glob.glob("/dev/dma_heap/*"))

    for path in perm_list:
        if os.path.exists(path):
            command = ["chmod", mode, "-R", path]
            tools.helpers.run.user(args, command, check=False)
```

默认权限为 777（全局可读写执行），Binder 设备使用更精确的 666。这是一个安全性与功能性的权衡——宽松的权限确保容器内各进程能正常访问硬件。

---

## 三、会话级挂载

除了设备节点，会话启动时还需要挂载用户环境：

```python
def generate_session_lxc_config(args, session):
    # XDG 运行时目录（tmpfs）
    make_entry("tmpfs", "/run/xdg", options="create=dir 0 0")

    # Wayland socket: /run/user/1000/wayland-0 → /run/xdg/wayland-0
    wayland_host = os.path.realpath(
        os.path.join(session["xdg_runtime_dir"], session["wayland_display"]))
    make_entry(wayland_host, "run/xdg/wayland-0")

    # PulseAudio socket: /run/user/1000/pulse/native → /run/xdg/pulse/native
    pulse_host = os.path.join(session["pulse_runtime_path"], "native")
    make_entry(pulse_host, "run/xdg/pulse/native")

    # 用户数据: ~/.local/share/waydroid/data → /data
    make_entry(session["waydroid_data"], "data", options="rbind 0 0")
```

这四个挂载构成了容器与宿主机环境的"通道"：
1. **Wayland socket**: 图形输出通道
2. **PulseAudio socket**: 音频输出通道
3. **用户数据目录**: 持久化存储
4. **XDG tmpfs**: 运行时临时文件

---

## 总结

Waydroid 的网络与设备直通方案体现了"最小化虚拟化，最大化直通"的设计理念：

1. **网络**: 标准 Linux 网桥 + NAT，兼容 iptables/nftables
2. **GPU**: 直接透传 DRM 渲染节点，无虚拟化层
3. **摄像头**: V4L2 设备直接透传
4. **音频**: PulseAudio socket 直接挂载
5. **Binder**: 内核模块 + 设备名称映射

---

*本文基于 [Waydroid](https://github.com/waydroid) 项目源码分析。*
