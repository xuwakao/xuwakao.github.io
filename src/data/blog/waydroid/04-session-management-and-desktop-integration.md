---
title: "Waydroid 源码分析（四）：会话管理与桌面集成"
description: "分析 Waydroid 的会话管理机制以及如何将 Android 应用窗口集成到 Linux 桌面环境中"
pubDatetime: 2021-05-21T00:00:00Z
modDatetime: 2021-05-21T00:00:00Z
author: "xuwakao"
slug: "waydroid-session-management"
tags:
  - android
  - linux
  - waydroid
  - desktop-integration
  - wayland
featured: false
---
# Waydroid 源码分析（四）：会话管理与桌面集成

> 本文分析 Waydroid 如何将 Android 应用无缝集成到 Linux 桌面——包括会话生命周期管理、Binder IPC 通信、.desktop 文件自动生成、剪贴板双向同步，以及 Android 通知桥接到 freedesktop 通知系统。

## 概述

Waydroid 不仅要运行 Android 系统，还要让 Android 应用"感觉像原生 Linux 应用"。这需要一套完整的桌面集成方案：

| 服务 | 文件 | 职责 |
|------|------|------|
| SessionManager | `tools/actions/session_manager.py` | 会话生命周期、信号处理 |
| UserManager | `tools/services/user_manager.py` | .desktop 文件生成、应用发现 |
| ClipboardManager | `tools/services/clipboard_manager.py` | 剪贴板双向同步 |
| NotificationManager | `tools/services/notification_manager.py` | Android→freedesktop 通知桥接 |
| HardwareManager | `tools/services/hardware_manager.py` | 电源/重启/升级回调 |
| IPlatform | `tools/interfaces/IPlatform.py` | Binder IPC 客户端 |

---

## 一、会话生命周期

### 启动流程

`session_manager.py:40` 中的 `start()` 函数是会话的入口点：

```python
def start(args, unlocked_cb=None, background=True):
    # 1. 注册 D-Bus 会话服务（防止重复启动）
    try:
        _name = dbus.service.BusName("id.waydro.Session",
                                     dbus.SessionBus(), do_not_queue=True)
    except dbus.exceptions.NameExistsException:
        logging.error("Session is already running")
        return

    # 2. 构建会话配置
    session = copy.copy(tools.config.session_defaults)

    # 3. 验证 Wayland 环境
    wayland_display = session["wayland_display"]
    if wayland_display == "None" or not wayland_display:
        wayland_display = session["wayland_display"] = "wayland-0"

    if os.path.isabs(wayland_display):
        wayland_socket_path = wayland_display
    else:
        xdg_runtime_dir = session["xdg_runtime_dir"]
        if xdg_runtime_dir == "None" or not xdg_runtime_dir:
            logging.error("XDG_RUNTIME_DIR is not set; "
                         "please don't start a Waydroid session with 'sudo'!")
            sys.exit(1)
        wayland_socket_path = os.path.join(xdg_runtime_dir, wayland_display)

    if not os.path.exists(wayland_socket_path):
        logging.error(f"Wayland socket '{wayland_socket_path}' doesn't exist; "
                     "are you running a Wayland compositor?")
        sys.exit(1)

    # 4. 检测显示 DPI
    dpi = tools.helpers.props.host_get(args, "ro.sf.lcd_density")
    if dpi == "":
        dpi = os.getenv("GRID_UNIT_PX")
        if dpi is not None:
            dpi = str(int(dpi) * 20)  # GRID_UNIT_PX 转换为 Android DPI
        else:
            dpi = "0"
    session["lcd_density"] = dpi

    # 5. 通过 D-Bus 启动容器
    tools.helpers.ipc.DBusContainerService().Start(session)

    # 6. 启动桌面集成服务
    services.user_manager.start(args, session, unlocked_cb)
    services.clipboard_manager.start(args)
    services.notification_manager.start(args, session)

    # 7. 进入 GLib 主循环
    service(args, mainloop)
```

DPI 检测有三个来源，按优先级：
1. 宿主机 `ro.sf.lcd_density` 属性（HALIUM 环境）
2. `GRID_UNIT_PX` 环境变量 × 20（Ubuntu Touch 兼容）
3. `"0"`（让 Android 自己决定）

### 信号处理

会话通过 Unix 信号实现优雅退出：

```python
mainloop = GLib.MainLoop()

def sigint_handler(data):
    do_stop(args, mainloop)
    stop_container(quit_session=False)

def sigusr_handler(data):
    do_stop(args, mainloop)  # 仅停止会话，不停止容器

GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGHUP,  sigint_handler, None)
GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGINT,  sigint_handler, None)
GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGTERM, sigint_handler, None)
GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGUSR1, sigusr_handler, None)
```

信号语义：
- **SIGINT/SIGTERM/SIGHUP**: 用户主动退出 → 停止会话 + 停止容器
- **SIGUSR1**: 容器发出的停止信号 → 仅停止会话（容器已经在停止中）

回忆上一篇中 `container_manager.py:269` 的代码：

```python
if quit_session:
    os.kill(int(args.session["pid"]), signal.SIGUSR1)
```

容器停止时通过 SIGUSR1 通知会话进程退出，避免了会话尝试重复停止容器。

### D-Bus 会话服务

```python
class DbusSessionManager(dbus.service.Object):
    @dbus.service.method("id.waydro.SessionManager",
                         in_signature='', out_signature='')
    def Stop(self):
        do_stop(self.args, self.looper)
        stop_container(quit_session=False)
```

`id.waydro.Session` 在 Session Bus 上注册，暴露 `Stop()` 方法。`waydroid session stop` 命令通过这个接口发送停止信号。

会话还监听 D-Bus 断开事件：

```python
def service(args, looper):
    bus = dbus.SessionBus()
    bus.set_exit_on_disconnect(False)
    bus.add_signal_receiver(lambda: handle_disconnect(args, looper),
                            signal_name='Disconnected',
                            dbus_interface='org.freedesktop.DBus.Local')
```

当用户注销或桌面环境重启导致 Session Bus 断开时，会话自动清理。

---

## 二、Binder IPC：IPlatform 接口

### 接口定义

`tools/interfaces/IPlatform.py` 是 Waydroid 与 Android 通信的核心。它通过 `gbinder` Python 库直接与容器内的 Android Binder 服务交互：

```python
INTERFACE = "lineageos.waydroid.IPlatform"
SERVICE_NAME = "waydroidplatform"

# Binder 事务码
TRANSACTION_getprop = 1
TRANSACTION_setprop = 2
TRANSACTION_getAppsInfo = 3
TRANSACTION_getAppInfo = 4
TRANSACTION_installApp = 5
TRANSACTION_removeApp = 6
TRANSACTION_launchApp = 7
TRANSACTION_getAppName = 8
TRANSACTION_settingsPutString = 9
TRANSACTION_settingsGetString = 10
TRANSACTION_settingsPutInt = 11
TRANSACTION_settingsGetInt = 12
TRANSACTION_launchIntent = 13
```

### 服务发现

`get_service()` 函数获取 Android 端的 Platform 服务：

```python
def get_service(args):
    helpers.drivers.loadBinderNodes(args)
    try:
        serviceManager = gbinder.ServiceManager(
            "/dev/" + args.BINDER_DRIVER,
            args.SERVICE_MANAGER_PROTOCOL,
            args.BINDER_PROTOCOL)
    except TypeError:
        # 旧版 gbinder 不支持协议参数
        serviceManager = gbinder.ServiceManager("/dev/" + args.BINDER_DRIVER)

    if not serviceManager.is_present():
        logging.info("Waiting for binder Service Manager...")
        if not wait_for_manager(serviceManager):
            return None

    # 重试获取服务（Android 启动需要时间）
    tries = 1000
    remote, status = serviceManager.get_service_sync(SERVICE_NAME)
    while not remote:
        if tries > 0:
            time.sleep(1)
            remote, status = serviceManager.get_service_sync(SERVICE_NAME)
            tries -= 1
        else:
            return None

    return IPlatform(remote)
```

这里有一个重要细节：`wait_for_manager()` 使用 GLib 主循环实现可中断的等待：

```python
def wait_for_manager(sm):
    mainloop = GLib.MainLoop()
    hndl = sm.add_presence_handler(
        lambda: mainloop.quit() if sm.is_present() else None)
    GLib.timeout_add_seconds(60, lambda: mainloop.quit())  # 60 秒超时
    GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGINT,
                         lambda _: mainloop.quit(), None)
    mainloop.run()
    sm.remove_handler(hndl)
    return sm.is_present()
```

### Binder 事务示例

以 `getAppsInfo()` 为例，展示完整的 Binder 通信过程：

```python
def getAppsInfo(self):
    request = self.client.new_request()
    reply, status = self.client.transact_sync_reply(
        TRANSACTION_getAppsInfo, request)

    apps_list = []
    if status:
        logging.error("Sending reply failed")
    else:
        reader = reply.init_reader()
        status, exception = reader.read_int32()
        if exception == 0:
            status, apps = reader.read_int32()  # 应用数量
            for j in range(apps):
                status, has_value = reader.read_int32()
                if has_value == 1:
                    appinfo = {
                        "name": reader.read_string16(),
                        "packageName": reader.read_string16(),
                        "action": reader.read_string16(),
                        "launchIntent": reader.read_string16(),
                        "componentPackageName": reader.read_string16(),
                        "componentClassName": reader.read_string16(),
                        "categories": []
                    }
                    status, categories = reader.read_int32()
                    for i in range(categories):
                        appinfo["categories"].append(reader.read_string16())
                    apps_list.append(appinfo)
    return apps_list
```

Binder 消息的序列化格式是手动编码的——每个字段按顺序读写，使用 `string16`（Android 的 `String16`/Java 的 `String`）和 `int32` 类型。这与 Android AIDL 生成的 Parcel 序列化格式一致。

---

## 三、UserManager：桌面文件生成

### 核心逻辑

`tools/services/user_manager.py` 是桌面集成最关键的组件。它监听 Android 用户解锁事件，然后为每个 Android 应用创建 freedesktop `.desktop` 文件：

```python
def start(args, session, unlocked_cb=None):
    apps_dir = Path(session["xdg_data_home"]) / "applications"
    apps_dir.mkdir(0o700, exist_ok=True)

    # 需要隐藏的系统应用
    system_apps = [
        "com.android.calculator2",
        "com.android.camera2",
        "com.android.contacts",
        "com.android.deskclock",
        "com.android.settings",
        "org.lineageos.aperture",
        # ...
    ]
```

### .desktop 文件生成

`updateDesktopFile()` 为每个应用创建标准的 freedesktop desktop entry：

```python
def updateDesktopFile(appInfo):
    packageName = appInfo["packageName"]
    desktop_file_path = apps_dir / f"waydroid.{packageName}.desktop"

    # 只为有 LAUNCHER category 的应用创建桌面文件
    showApp = False
    for cat in appInfo["categories"]:
        if cat.strip() == "android.intent.category.LAUNCHER":
            showApp = True
            break

    if not showApp:
        desktop_file_path.unlink(missing_ok=True)
        return

    # 使用 GLib.KeyFile 读写 desktop 文件（保留已有注释和翻译）
    desktop_file = GLib.KeyFile()
    with suppress(GLib.GError):
        desktop_file.load_from_file(str(desktop_file_path), flags)

    desktop_file.set_string("Desktop Entry", "Type", "Application")
    desktop_file.set_string("Desktop Entry", "Name", appInfo["name"])
    desktop_file.set_string("Desktop Entry", "Exec",
                           f"waydroid app launch {packageName}")
    desktop_file.set_string("Desktop Entry", "Icon",
                           str(waydroid_data_icons_dir / f"{packageName}.png"))

    # Waydroid 特有分类
    glib_key_file_prepend_string_list(desktop_file,
        "Desktop Entry", "Categories", ["X-WayDroid-App"])

    # 表单因子支持（桌面 + 移动）
    desktop_file.set_string_list("Desktop Entry",
        "X-Purism-FormFactor", ["Workstation", "Mobile"])

    # 应用设置快捷动作
    glib_key_file_prepend_string_list(desktop_file,
        "Desktop Entry", "Actions", ["app-settings"])

    # 系统应用默认隐藏
    if packageName in system_apps and \
       not glib_key_file_has_value(desktop_file, "Desktop Entry", "NoDisplay"):
        desktop_file.set_boolean("Desktop Entry", "NoDisplay", True)

    # 设置按钮：打开 Android 设置中的应用详情页
    desktop_file.set_string("Desktop Action app-settings", "Name", "App Settings")
    desktop_file.set_string("Desktop Action app-settings", "Exec",
        f"waydroid app intent android.settings.APPLICATION_DETAILS_SETTINGS "
        f"package:{packageName}")

    desktop_file.save_to_file(str(desktop_file_path))
```

生成的 .desktop 文件示例：

```ini
[Desktop Entry]
Type=Application
Name=Firefox
Exec=waydroid app launch org.mozilla.firefox
Icon=/home/user/.local/share/waydroid/data/icons/org.mozilla.firefox.png
Categories=X-WayDroid-App;
X-Purism-FormFactor=Workstation;Mobile;
Actions=app-settings;

[Desktop Action app-settings]
Name=App Settings
Exec=waydroid app intent android.settings.APPLICATION_DETAILS_SETTINGS package:org.mozilla.firefox
Icon=/home/user/.local/share/waydroid/data/icons/com.android.settings.png
```

### 实时应用同步

UserManager 通过 `IUserMonitor` 接口监听 Android 包状态变化：

```python
def userUnlocked(uid):
    # Android 用户解锁后，获取所有应用信息
    platformService = IPlatform.get_service(args)
    if platformService:
        appsList = platformService.getAppsInfo()
        # 创建/更新所有应用的 desktop 文件
        for app in appsList:
            updateDesktopFile(app)
        # 删除不再存在的应用的 desktop 文件
        for existing in apps_dir.glob("waydroid.*.desktop"):
            if existing.name not in map(
                lambda a: f"waydroid.{a['packageName']}.desktop", appsList):
                existing.unlink()

    if unlocked_cb:
        unlocked_cb()

def packageStateChanged(mode, packageName, uid):
    platformService = IPlatform.get_service(args)
    if platformService:
        if mode == IUserMonitor.PACKAGE_REMOVED:
            # 应用卸载 → 删除 desktop 文件
            desktop_file_path.unlink(missing_ok=True)
        else:
            # 应用安装/更新 → 创建/更新 desktop 文件
            appInfo = platformService.getAppInfo(packageName)
            updateDesktopFile(appInfo)
```

### 迁移机制

UserManager 还包含版本迁移逻辑：

```python
def user_migration():
    if not any(apps_dir.glob('waydroid.*.desktop')):
        return  # 首次运行，无需迁移

    # 迁移 1: 删除旧的 Waydroid.desktop 主入口
    migrated_main_path = waydroid_user_state_dir / ".migrated-main-desktop-file"
    if not migrated_main_path.exists():
        (apps_dir / "Waydroid.desktop").unlink(missing_ok=True)
        migrated_main_path.touch()

    # 迁移 2: 更新 app-settings 桌面动作格式
    migrated_apps_path = waydroid_user_state_dir / ".migrated-app-settings-desktop-action"
    if not migrated_apps_path.exists():
        for app in apps_dir.glob("waydroid.*.desktop"):
            # 移除旧格式的 app_settings action
            desktop_file.remove_group("Desktop Action app_settings")
            actions.remove("app_settings")
            desktop_file.save_to_file(str(app))
        migrated_apps_path.touch()
```

迁移使用 sentinel 文件（如 `.migrated-main-desktop-file`）标记已完成的迁移，避免重复执行。

---

## 四、ClipboardManager：剪贴板同步

`tools/services/clipboard_manager.py` 实现了宿主机与 Android 之间的剪贴板双向同步：

```python
def start(args):
    def sendClipboardData(value):
        """Android → 宿主机：将 Android 剪贴板内容设置到宿主机"""
        try:
            pyclip.copy(value)
        except Exception as e:
            logging.debug(str(e))

    def getClipboardData():
        """宿主机 → Android：获取宿主机剪贴板内容"""
        try:
            return pyclip.paste()
        except Exception as e:
            logging.debug(str(e))
        return ""

    def service_thread():
        while not stopping:
            IClipboard.add_service(args, sendClipboardData, getClipboardData)

    if canClip:
        args.clipboard_manager = threading.Thread(target=service_thread)
        args.clipboard_manager.start()
    else:
        logging.debug("Skipping clipboard manager service "
                     "because of missing pyclip package")
```

架构简洁明了：
1. `pyclip` 库作为宿主机剪贴板的统一接口
2. `IClipboard` Binder 接口连接 Android 端
3. Android 端（通过 HWComposer 中的 `IWaydroidClipboard` HIDL 接口）调用 `sendClipboardData` 和 `getClipboardData`
4. 如果 `pyclip` 不可用（缺少依赖），剪贴板服务优雅地跳过启动

---

## 五、NotificationManager：通知桥接

`tools/services/notification_manager.py` 将 Android 通知桥接到 Linux 桌面的 freedesktop 通知系统。

### freedesktop 通知接口

```python
def start(args, session):
    # 连接到 freedesktop 通知服务
    try:
        dbus_proxy = dbus.Interface(
            dbus.SessionBus().get_object(
                "org.freedesktop.Notifications",
                "/org/freedesktop/Notifications"),
            "org.freedesktop.Notifications")
    except dbus.DBusException:
        logging.info("Skipping notification manager service "
                    "because we could not connect to the notifications server")
        return
```

### 通知转发

```python
def notify(replaces_id, app_name, package_name, summary, body,
           actions, image_data, category, suppress_sound,
           expire_timeout, resident, transient, urgency):

    app_icon = ""  # 使用 desktop-entry hint 代替直接图标路径

    # 将 Android 的 action 列表展平为 freedesktop 格式
    actions_flat = [s for action in actions for s in (action.id, action.label)]

    # 构建 hints
    hints = {
        "desktop-entry": f"waydroid.{package_name}",  # 关联 .desktop 文件
        "resident": dbus.types.Boolean(resident),
        "transient": dbus.types.Boolean(transient),
        "urgency": dbus.types.Byte(urgency),
        "suppress-sound": dbus.types.Boolean(suppress_sound),
    }

    if category:
        hints["category"] = category

    # 传递通知图片（Android ImageData → freedesktop image-data）
    if image_data:
        hints["image-data"] = dbus.types.Struct([
            image_data.width,
            image_data.height,
            image_data.rowstride,
            image_data.has_alpha,
            8,                          # bits per sample
            4 if image_data.has_alpha else 3,  # channels
            dbus.types.Array(image_data.data, signature="y")
        ])

    return dbus_proxy.Notify(app_name, replaces_id, app_icon,
                             summary, body, actions_flat,
                             hints, expire_timeout)
```

几个精细的设计：

1. **`desktop-entry` hint**: 设置为 `waydroid.<package>` 使通知图标自动与 .desktop 文件中的图标一致，避免了单独传递图标路径
2. **image-data**: 将 Android 的通知图片转换为 freedesktop 的 `image-data` 格式（raw pixel 数据）
3. **urgency 映射**: Android 的通知优先级映射到 freedesktop 的 urgency（0=低, 1=正常, 2=关键）

### 通知动作回调

当用户点击通知上的按钮时，需要将事件传回 Android：

```python
listeners = []
pending_tokens = dict()

def onActivationToken(notification_id, token):
    pending_tokens[int(notification_id)] = str(token)

def onActionInvoked(notification_id, action_id):
    token = pending_tokens.pop(int(notification_id), "")
    for listener in listeners:
        listener.onActionInvoked(int(notification_id), str(action_id), str(token))

# 监听 freedesktop 通知的交互信号
bus_signals.append(
    dbus_proxy.connect_to_signal("ActivationToken", onActivationToken))
bus_signals.append(
    dbus_proxy.connect_to_signal("ActionInvoked", onActionInvoked))
```

`ActivationToken` 是 freedesktop 通知规范中用于窗口激活的 token，确保通知打开的应用窗口能正确获得焦点。

---

## 六、HardwareManager：系统操作回调

`tools/services/hardware_manager.py` 处理来自 Android 的系统操作请求：

```python
def start(args):
    def enableNFC(enable):
        logging.debug("Function enableNFC not implemented")

    def enableBluetooth(enable):
        logging.debug("Function enableBluetooth not implemented")

    def suspend():
        cfg = tools.config.load(args)
        if cfg["waydroid"]["suspend_action"] == "stop":
            tools.actions.session_manager.stop(args)
        else:
            tools.actions.container_manager.freeze(args)

    def reboot():
        helpers.lxc.stop(args)
        helpers.lxc.start(args)

    def upgrade(system_zip, system_time, vendor_zip, vendor_time):
        helpers.lxc.stop(args)
        helpers.images.umount_rootfs(args)
        helpers.images.replace(args, system_zip, system_time,
                               vendor_zip, vendor_time)
        args.session["background_start"] = "false"
        helpers.images.mount_rootfs(args, args.images_path, args.session)
        helpers.protocol.set_aidl_version(args)
        helpers.lxc.start(args)
```

关键设计点：

1. **suspend()**: 当 Android 请求息屏/休眠时，根据配置决定是冻结容器（`freeze`）还是完全停止（`stop`）。冻结保留容器状态，恢复更快。

2. **reboot()**: Android 重启只是停止并重新启动 LXC 容器，不会重启宿主机。

3. **upgrade()**: 系统升级的完整流程——停止容器 → 卸载 rootfs → 替换镜像 → 重新挂载 → 重新启动。注意设置 `background_start = "false"` 确保升级后显示完整 UI。

4. **NFC/蓝牙**: 标记为未实现（`not implemented`），这也反映了 Waydroid 当前的功能限制。

---

## 七、服务线程模型

所有桌面集成服务共享相同的线程模型：

```python
# 通用模式
def start(args):
    def service_thread():
        while not stopping:
            ISomeInterface.add_service(args, callback1, callback2, ...)

    global stopping
    stopping = False
    args.some_manager = threading.Thread(target=service_thread)
    args.some_manager.start()

def stop(args):
    global stopping
    stopping = True
    try:
        if args.someLoop:
            args.someLoop.quit()
    except AttributeError:
        logging.debug("Service is not even started")
```

`add_service()` 内部使用 Binder 的服务注册机制——它会阻塞直到服务连接断开，然后 `while not stopping` 循环重新注册。这提供了自动重连能力：如果 Android 端的服务重启（如系统更新后），Python 端会自动重新建立连接。

---

## 总结

Waydroid 的会话管理与桌面集成展现了"Android 应用即 Linux 应用"的设计理念：

1. **.desktop 文件自动生成**: Android 应用自动出现在 Linux 桌面的应用菜单中
2. **实时同步**: 安装/卸载应用时，桌面文件即时更新
3. **剪贴板无缝共享**: 通过 pyclip + Binder IPC 实现双向同步
4. **通知桥接**: Android 通知以原生 Linux 通知形式显示，支持图标、图片和交互按钮
5. **优雅的信号处理**: SIGINT/SIGTERM/SIGUSR1 各有语义，避免资源泄露

---

## 下一篇预告

在下一篇文章中，我们将分析 **网络架构与设备直通**——包括 waydroid0 网桥的创建、NAT/DHCP 配置、iptables/nftables 防火墙规则，以及 GPU、摄像头等设备的 passthrough 实现。

---

*本文基于 [Waydroid](https://github.com/waydroid) 项目源码分析。*
