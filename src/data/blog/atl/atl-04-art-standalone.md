---
title: "ATL深度解析（4）ART 独立化 — 把 Android 虚拟机搬到 Linux 桌面"
description: "分析 ATL 如何将 ART 虚拟机从 AOSP 中剥离出来，在普通 Linux 环境中独立运行 DEX 字节码"
pubDatetime: 2025-11-23T00:00:00Z
modDatetime: 2025-11-23T00:00:00Z
author: "xuwakao"
slug: "atl-art-standalone"
tags:
  - android
  - linux
  - atl
  - art
  - runtime
featured: false
---
# ART 独立化 — 把 Android 虚拟机搬到 Linux 桌面

## 引言

ART（Android Runtime）是 Android 系统的 Java 虚拟机，负责执行 APK 中的 DEX 字节码。在 AOSP 中，ART 深度嵌入 Android 系统，依赖 Bionic libc、Soong 构建系统以及数十个 Android 专有库。`art_standalone` 项目的目标是将 ART 从 AOSP 中**完整提取**出来，使其能在标准 Linux 桌面系统上独立编译和运行。

本文基于 `art_standalone` 的源码和 222 个 commit 历史，分析这个"提取手术"的技术细节。

## 一、ART 在 AOSP 中的角色

### 什么是 ART

ART 是 Android 5.0 引入的运行时，取代了之前的 Dalvik VM。它的核心能力包括：

- **DEX 字节码执行**：解释器（interpreter）逐条执行 DEX 指令
- **JIT 编译**：运行时将热点代码编译为机器码（Just-In-Time）
- **AOT 编译**：通过 `dex2oat` 工具在安装时将 DEX 预编译为 OAT 文件（Ahead-Of-Time）
- **垃圾回收**：并发标记-清除 GC
- **JNI 支持**：Java ↔ C/C++ 互调用

### ART 在 AOSP 中的依赖

ART 的源码位于 AOSP 的 `art/` 目录，但它的编译依赖分散在整个 AOSP 树中：

- **构建系统**：Soong（Android 的 Ninja 前端），需要完整的 AOSP 构建环境
- **C 标准库**：Bionic libc（不是 glibc）
- **基础库**：`libbase`、`libcutils`、`libutils`、`liblog` 等 Android 平台库
- **Java 核心库**：`libcore/`（包含 `java.lang.*`、`java.util.*` 的 Android 特化版本）
- **加密库**：BouncyCastle、Conscrypt
- **资源框架**：`libandroidfw`（解析 APK 资源）
- **ICU**：国际化支持

在标准 AOSP 构建中，编译 ART 需要先构建上述所有依赖——这意味着几乎需要整个 AOSP 源码树。

## 二、art_standalone 的项目结构

`art_standalone` 将 ART 及其必要依赖提取到一个自包含的仓库中：

```
art_standalone/
├── art/              ← AOSP ART 核心（runtime, compiler, dex2oat, dalvikvm）
├── libcore/          ← Java 标准库（OpenJDK + Android luni）
├── dalvik/           ← dx 工具（.class → .dex 转换）
├── libandroidfw/     ← Android 资源框架
├── libbase/          ← Android 基础 C++ 工具库
├── libnativehelper/  ← JNI 辅助函数
├── libziparchive/    ← ZIP/JAR 读写
├── bionic/           ← 极简提取（仅 dlmalloc.h）
├── external/         ← 第三方依赖
│   ├── bouncycastle/ ← 加密库（从 AOSP 精简版）
│   ├── wolfssljni/   ← TLS/SSL（替代 Conscrypt）
│   ├── okhttp/       ← HTTP 客户端
│   ├── libunwind/    ← 栈回溯
│   ├── junit/        ← 测试框架
│   └── ...
├── build/            ← AOSP 构建系统基础设施（99 个 Makefile）
├── system/           ← 系统级工具库
├── Makefile          ← 顶层构建入口（替代 Soong）
└── art-standalone.pc.in ← pkg-config 模板
```

关键设计决策：**Bionic libc 本身没有被包含**。`bionic/` 目录下只有一个 `dlmalloc.h` 头文件。ART 运行时实际使用宿主系统的 glibc/musl，Bionic 兼容性由单独的 `bionic_translation` 项目处理。

## 三、构建系统：从 Soong 到 Makefile

### AOSP 的构建系统

AOSP 使用 Soong（基于 Blueprint 的 Ninja 生成器），配合 `Android.bp` 和 `Android.mk` 文件。构建 ART 需要：

```bash
# AOSP 标准流程
source build/envsetup.sh
lunch aosp_x86_64-eng
make art  # 需要完整 AOSP 源码树
```

### art_standalone 的方案

`art_standalone` 用一个顶层 `Makefile` 替代 Soong，但**保留了 AOSP 的 Android.mk 文件**作为子构建系统。这是一个务实的折中——完全重写构建规则工作量巨大，不如在顶层封装。

`Makefile` 定义了关键配置：

```makefile
# 关闭不需要的特性
ANDROID_COMPILE_WITH_JACK := false   # Jack 是废弃的 Java 编译器
WITHOUT_CLANG := true                 # 只用 GCC（Clang 路径未清理）
WITHOUT_LIBCOMPILER_RT := true        # 不在精简源码树中
LOCAL_MULTILIB := none                # 单架构编译
```

安装路径可配置：

```makefile
____PREFIX ?= /usr/local
____LIBDIR ?= $(shell (ld --verbose | grep SEARCH_DIR | grep -oE "/usr/lib([^\"]*)" || echo /usr/lib) | head -n 1 | cut -c 6-)
                                      # 自动检测发行版的库目录（lib/lib64/lib/x86_64-linux-gnu 等）
____INCLUDEDIR ?= include
```

## 四、构建产物

`make install` 安装以下组件：

### Native 库

| 库 | 安装位置 | 作用 |
|---|---|---|
| `libart.so` | `lib/art/` | ART VM 核心（解释器、JIT、GC） |
| `libart-compiler.so` | `lib/art/` | JIT/AOT 编译基础设施 |
| `libartbase.so` | `lib/art/` | ART 基础工具 |
| `libdexfile.so` | `lib/art/` | DEX 文件解析 |
| `libandroidfw.so` | `lib/art/` | APK 资源框架 |
| `libnativebridge.so` | `lib/art/` | 跨架构 native 桥接 |
| `liblog.so` | `lib/art/` | Android 日志 |
| `libjavacore.so` | `lib/java/dex/art/natives/` | Java 核心库 native 方法 |
| `libopenjdk.so` | `lib/java/dex/art/natives/` | OpenJDK JVM 接口 |
| `libwolfssljni.so` | `lib/java/dex/art/natives/` | TLS/SSL native |

### Bootclasspath JAR（DEX 格式）

```
lib/java/dex/art/
├── core-libart-hostdex.jar    ← ART 版 Java 核心库
├── core-oj-hostdex.jar        ← OpenJDK 统一源码
├── bouncycastle-hostdex.jar   ← 加密库
├── okhttp-hostdex.jar         ← HTTP 客户端
├── wolfssljni-hostdex.jar     ← TLS/SSL
├── apachehttp-hostdex.jar     ← Apache HTTP
├── apache-xml-hostdex.jar     ← XML 工具
├── core-junit-hostdex.jar     ← JUnit 框架
└── hamcrest-hostdex.jar       ← 测试匹配器
```

这些 JAR 构成 ART 的 bootclasspath，提供 `java.lang.*`、`java.util.*`、`javax.crypto.*` 等 Java 标准类。

> **注意命名关系**：art_standalone 同时安装了编译时中间产物（`core-all_classes.jar`、`core-junit_classes.jar`、`junit-runner_classes.jar`，包含 `.class` 文件）和运行时 JAR（上述 `-hostdex.jar` 系列，包含 DEX 字节码）。ATL 编译 `api-impl.jar` 时使用前者作为 `-bootclasspath`（`src/api-impl/meson.build:786`），运行时 ART VM 加载后者。

```python
java_args = ['-bootclasspath', bootclasspath, '-source', '1.8', '-target', '1.8', ...]
```

### 可执行文件和开发文件

- `dalvikvm` / `dalvikvm64` — ART VM 命令行入口
- `dex2oat` — DEX → OAT AOT 编译器
- `dx` — .class → .dex 字节码转换器
- `art-standalone.pc` — pkg-config 文件，供 ATL 的 Meson 构建系统发现 ART

## 五、关键修改（vs 原版 AOSP）

`art_standalone` 的 222 个 commit 中，大部分是构建适配和 bug 修复。以下是最重要的几个修改：

### 5.1 JNI 非致命查找（ART_NON_FATAL_JNI_LOOKUPS）

**问题**：Android App 的 native 代码通常在初始化时缓存大量 JNI 引用（FindClass、GetMethodID 等）。在 AOSP 中，所有 Framework 类都存在，所以这些查找一定成功。但在 ATL 中，api-impl.jar 只实现了部分类——缺失的类会导致 `FindClass` 返回 NULL，ART 默认行为是**直接 abort 进程**。

**解决方案**（修改 `art/runtime/jni/jni_internal.cc`）：

新增环境变量 `ART_NON_FATAL_JNI_LOOKUPS`。启用后，ART 在 JNI 查找失败时不再 abort，而是**清除异常并返回 NULL**，让调用方有机会自行处理。

核心实现是一个异常清除函数（`jni_internal.cc:88-97`）：

```c
static inline void clear_exception_if_non_fatal_env_set(JNIEnv *env)
{
  if (art_non_fatal_jni_lookups) {
    LOG(ERROR) << "ART_NON_FATAL_JNI_LOOKUPS set, will clear the exception\n";
    if (env->ExceptionCheck()) {
      env->ExceptionDescribe();  // 将异常栈打印到 stderr（便于调试）
      env->ExceptionClear();     // 清除挂起的异常
    }
  }
}
```

这个函数被插入到所有关键的 JNI 查找函数中。以 `FindClass` 为例（`jni_internal.cc:760-781`）：

```c
static jclass FindClass(JNIEnv* env, const char* name) {
    // ... 查找类 ...
    jclass ret = soa.AddLocalReference<jclass>(c);
    if(!ret) {
      fprintf(stderr, "STRAWTOGRASP: FindClass(%s) returning NULL\n", name);
      clear_exception_if_non_fatal_env_set(env);  // ← 关键：清除异常而非 abort
    }
    return ret;  // 返回 NULL，不崩溃
}
```

同样的保护也被加到了 `GetMethodID`、`GetStaticMethodID`、`GetFieldID`、`GetStaticFieldID` 等函数中。此外，`check_jni.cc` 中的 `CHECK_NON_NULL_ARGUMENT` 宏也被修改为在设置了该环境变量时不 abort。

#### 失败后的真实处理链

一个关键的问题是：异常被清除了、函数返回了 NULL，但**缺失的类/方法确实不存在**——后续代码用 NULL 的句柄去调用方法会怎样？

ATL 通过**三层防线**实现优雅降级：

**第一层：ART JNI 层**——FindClass/GetMethodID 返回 NULL，异常被清除而非 abort。

**第二层：ATL 的 handle_cache**——ATL 在启动时通过 `set_up_handle_cache()`（`handle_cache.c`）预缓存所有常用的类和方法引用。如果某个类不存在，对应的缓存槽位就是 NULL。后续用 NULL 的 methodID 调用 `CallVoidMethod(env, obj, NULL)` 时，ART 的 `CHECK_NON_NULL_ARGUMENT` 会再次拦截——同样不 abort，而是记录错误并返回。

**第三层：ATL 的业务代码**——ATL 的 JNI 代码中广泛使用防御式异常检查：

```c
// 典型模式（出现在 util.c、android_view_View.c 等多处）
(*env)->CallVoidMethod(env, obj, handle_cache.some.method);
if ((*env)->ExceptionCheck(env)) {
    (*env)->ExceptionDescribe(env);  // 打印异常信息
    (*env)->ExceptionClear(env);     // 清除，继续执行
}
```

最终效果是：**缺失的功能被静默跳过，而不是导致整个 App 崩溃**。对于用户来说，可能表现为某些功能不可用（例如某个 UI 控件不显示），但 App 的核心功能可以继续工作。所有被跳过的类和方法都会在 stderr 中留下 `STRAWTOGRASP: FindClass(xxx) returning NULL` 格式的日志，供开发者排查。

这个机制对 ATL 的"按需实现"策略至关重要——它让 ATL 可以只实现 App 实际需要的 API 子集，而不必为了一个不相关的缺失类导致整个 App 无法启动。

### 5.2 dex2oat 跳过 framework-res.apk

**问题**：ART 会尝试对 classpath 中的所有 JAR/APK 运行 dex2oat 进行 AOT 编译。但 `framework-res.apk` 只包含资源（XML、图片、主题），没有 DEX 字节码——dex2oat 处理它时会失败。

**解决方案**（修改 `art/runtime/oat_file_assistant.cc`）：检测到 `framework-res.apk` 时跳过 AOT 编译。

### 5.3 Runtime.loadLibrary() 废弃警告移除

**问题**：AOSP 将 `Runtime.loadLibrary(String, ClassLoader)` 标记为废弃，调用时会打印错误日志。但 ATL 在 `main.c:431` 中正是使用这个方法加载 `libtranslation_layer_main.so`：

```c
(*env)->CallVoidMethod(env, java_runtime, loadLibrary_with_classloader,
    _JSTRING("translation_layer_main"), class_loader);
```

**解决方案**（修改 `libcore/ojluni/src/main/java/java/lang/Runtime.java`）：注释掉废弃警告日志。

### 5.4 libandroidfw C API 新增

**背景**：`libandroidfw` 是 AOSP 的资源框架库，用 C++ 编写（`AssetManager2`、`ApkAssets` 等类）。ATL 的 JNI 代码是 C，不能直接调用 C++ 类。

**解决方案**：新增 `androidfw_c_api.h`（573 行）和 `androidfw_c_api.cpp`，提供纯 C 接口：

```c
// art_standalone/libandroidfw/include/androidfw/androidfw_c_api.h（部分）

// Asset 操作
struct Asset *AssetManager_openNonAsset(struct AssetManager *, const char *path, int mode);
const void *Asset_getBuffer(struct Asset *, bool wordAligned);
int Asset_read(struct Asset *, void *buf, size_t count);
int Asset_openFileDescriptor(struct Asset *, off_t *out_start, off_t *out_length);

// 资源解析
int AssetManager_getResource(struct AssetManager *, uint32_t resid, ...);
uint32_t AssetManager_getResourceId(struct AssetManager *, const char *name, ...);

// 线程安全
void AssetManager_lock(struct AssetManager *);
void AssetManager_unlock(struct AssetManager *);

// 目录叠加（ATL 新增，用于数据目录覆盖 APK 资源）
struct ApkAssets *ApkAssets_loadDir(const char *path);
```

ATL 的 `asset_manager.c` 通过这些 C 函数访问 APK 资源：

```c
// src/libandroid/asset_manager.c:29
struct Asset *AAssetManager_open(struct AssetManager *asset_manager, const char *file_name, int mode) {
    char *path = malloc(strlen(ASSET_DIR) + strlen(file_name) + 1);
    sprintf(path, "%s%s", ASSET_DIR, file_name);
    struct Asset *asset = AssetManager_openNonAsset(asset_manager, path, mode);
    free(path);
    return asset;
}
```

### 5.5 BouncyCastle 算法恢复

**背景**：BouncyCastle 是 Java 加密库。AOSP 从 BouncyCastle 中**删除**了部分算法（EC、RSA、AES 的某些变体），将它们委托给 Google 的 Conscrypt（基于 BoringSSL 的 TLS 库）。但 art_standalone 没有 Conscrypt。

**解决方案**：在 BouncyCastle 中恢复被 AOSP 删除的算法，并调整 Provider 优先级：

```
安全 Provider 优先级：BouncyCastle > WolfSSL
原因：WolfSSL 不提供所有 JAR 签名验证需要的算法
```

### 5.6 GCC 兼容性修复

AOSP 主要用 Clang 编译，art_standalone 使用 GCC。修改 `art/build/Android.common_build.mk` 关闭了一些 GCC 不支持或过于严格的警告：

```makefile
# 禁用在 AOSP 头文件中不可避免的警告
-Wno-invalid-offsetof
-Wno-deprecated-declarations
-Wno-comment
-Wno-attributes
```

还有针对 GCC 14 和 GCC 15 的专项兼容性修复。

## 六、pkg-config 集成

art_standalone 安装一个 `art-standalone.pc` 文件，ATL 通过 Meson 的 `dependency()` 机制使用它：

```python
# ATL 的 meson.build:12
libart_dep = dependency('art-standalone')

# 获取 bootclasspath JAR 的目录
bootclasspath_dir = libart_dep.get_variable(pkgconfig: 'libdir') / 'java'
```

ATL 还通过 `dladdr(JNI_CreateJavaVM, ...)` 动态定位 `libart.so` 的安装路径（`main.c:343-357`），以此推算 DEX 文件的安装位置：

```c
Dl_info libart_so_dl_info;
dladdr(JNI_CreateJavaVM, &libart_so_dl_info);
char *libart_so_full_path = strdup(libart_so_dl_info.dli_fname);
*strrchr(libart_so_full_path, '/') = '\0'; // → /usr/lib64/art
dex_install_dir = g_strdup_printf("%s/%s", libart_so_full_path, REL_DEX_INSTALL_PATH);
```

## 七、ART 在 ATL 中的使用方式

ATL 主程序通过标准 JNI 接口使用 ART。`create_vm()` 函数（`main.c:83-143`）展示了完整的 VM 创建过程：

```c
JNIEnv *create_vm(...) {
    JavaVMInitArgs args = { .version = JNI_VERSION_1_6, .nOptions = 3 };

    // 库搜索路径（ATL native 库 + App 的 lib 目录）
    options[0].optionString = "-Djava.library.path=...";

    // Classpath: api-impl.jar + app.apk + framework-res.apk
    options[1].optionString = "-Djava.class.path=...";

    // JNI 检查
    options[2].optionString = "-Xcheck:jni";

    int ret = JNI_CreateJavaVM(&jvm, &env, &args);
}
```

创建 VM 后，ATL 不使用 ART 的任何内部 API——只通过标准 JNI 接口（`FindClass`、`GetMethodID`、`CallVoidMethod` 等）与 Java 代码交互。这是一个干净的接口边界。

> **AOT 缓存**：ART 在桌面 Linux 上将 AOT 编译的 OAT 文件缓存在 `~/.cache/art/` 目录下（对应 Android 上的 `/data/dalvik-cache/`）。如果切换了 dex2oat 配置或更新了 DEX 文件，可能需要手动清除该缓存目录以避免使用过期的编译产物。

唯一的例外是 `src/libandroid/looper.c`，它直接调用 ART 中 `android::Looper` 类的 C++ 方法（通过 mangled name），因为 ALooper NDK API 是对 `android::Looper` 的薄封装，而 art_standalone 保留了这个 C++ 实现。

## 八、对比总结

| 维度 | AOSP 中的 ART | art_standalone |
|------|-------------|----------------|
| **构建系统** | Soong/Ninja（需完整 AOSP） | 自包含 Makefile |
| **C 标准库** | Bionic | 宿主 glibc/musl（+ bionic_translation） |
| **编译器** | Clang | GCC（Clang 未维护） |
| **Java 核心库** | libcore（AOSP 版） | 同（有少量修改，如移除 `Runtime.loadLibrary` 废弃警告等） |
| **加密** | BouncyCastle + Conscrypt | BouncyCastle + WolfSSL（恢复了算法） |
| **资源框架** | libandroidfw（C++ API） | 同 + 新增 C API（573 行） |
| **JNI 失败处理** | abort | 可配置为非致命 |
| **目标平台** | Android 设备 | Linux 桌面 |
| **修改量** | — | 222 commits |

art_standalone 的本质不是"修改 ART"，而是**"让 ART 脱离 Android 构建环境"**。ART 的核心逻辑（解释器、JIT、GC）几乎未动——真正的工程量在构建系统适配、编译器兼容性、缺失依赖的替代方案上。

---

*上一篇：[NDK API 重实现](atl-03-ndk-api-reimplementation.md) | 下一篇：[Bionic 兼容层](atl-05-bionic-translation.md)*
