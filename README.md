# Xiao Yu · Personal Daily Assistant

这是个人日常管理小秘书。网页默认使用本地缓存，同时支持通过 Supabase Auth 登录后同步到云端；这样在电脑和手机之间可以共享同一套数据。

## 启用云端同步

1. 在 Supabase Dashboard 的 SQL Editor 中执行项目里的 `supabase-schema.sql`；
2. 在 Supabase 的 Authentication → URL Configuration 中，把当前 GitHub Pages 地址加入 Site URL 或 Redirect URLs：
   `https://walzxy.github.io/personal-assistant/`；
3. 打开网页，点击侧边栏的 `Connect cloud sync`，可以使用 `Continue with GitHub`，也可以输入邮箱并打开收到的 magic link；
4. 登录成功后，数据会以本地优先、延迟写入的方式同步到 `workspace_state` 表。

网页前端只使用 Publishable key；Secret key、service role key 和数据库密码不应放入仓库或网页。

## 本地运行

在项目目录执行：

```powershell
node serve.mjs
```

然后打开：

```text
http://127.0.0.1:4173
```

## 当前已实现

- 响应式三栏布局，移动端抽屉式导航；
- 任务页作为当前首页；
- Regular Task、Standalone Task、Long-term Task 和 Sub-task 展示；
- 任务创建、任务详情、10 格进度条；
- 已创建任务可编辑标题、日期、DDL、预计时长、难度、备注和任务颜色；
- Regular Task 最多 3 个同级子任务，Long-term Task 支持子任务确认完成；
- 任务计时开始/暂停；
- 100% 后进入确认完成状态；
- 今日、周、月视图；
- 周/月习惯 KPI 与当日打卡；
- 统一课程/任务时间轴；
- 莫兰迪任务色库：灰蓝、鼠尾草绿、干枯玫瑰、燕麦、香芋紫、灰橘、灰青、浅灰粉；
- 课表 JSON 导入预览和实例生成；
- 任务与课程时间重叠提示；
- 数据导出；
- Reading、Xiao Yu message board、Archive、Inspiration box 占位入口。

## 当前暂不实现

- 奖励抽奖和 Archive 数据逻辑；
- 阅读清单和阅读笔记；
- Xiao Yu 对话界面；
- OpenClaw 写入接口和细粒度实体表；当前先使用 `workspace_state` JSON 记录完成低风险迁移；
- 独立课程推送提醒；

## 后续维护顺序

1. 将 `workspace_state` 迁移为任务、事件、课程、习惯等明确的数据表；
2. 增加云端备份、冲突检测和离线同步队列；
3. 接入 OpenClaw 的只读日报接口；
4. 再开放受权限控制的任务写入接口；
5. 最后实现奖励、阅读、留言板和灵感箱。
