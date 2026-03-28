export const SITE = {
  website: "https://wacao.cn/",
  author: "xuwakao",
  profile: "https://github.com/xuwakao",
  desc: "源码分析 · 架构设计 · 工程实践",
  title: "Wacao's Den",
  ogImage: "og.png",
  lightAndDarkMode: true,
  postPerIndex: 10,
  postPerPage: 10,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true,
  editPost: {
    enabled: false,
    text: "",
    url: "",
  },
  dynamicOgImage: true,
  dir: "ltr",
  lang: "zh-CN",
  timezone: "Asia/Shanghai",
} as const;
