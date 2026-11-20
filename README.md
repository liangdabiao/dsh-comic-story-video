# 漫画故事片场 · dsh-comic-story-video

把任意选题做成 110–135 秒竖屏「图片在讲故事」的漫画短视频：生成式线稿**逐笔描出**、台词气泡**按时间弹入**、单口配音 + 大字幕。产物 `out/final.mp4`（1080×1920），可直接发抖音 / 视频号 / 小红书。
<img width="1901" height="1155" alt="image" src="https://github.com/user-attachments/assets/35612071-f088-4ab1-875e-2309a5ac4055" />

> **声音是主线。** 把音轨单独抽出来听，必须是一条讲得通的故事；画面负责加戏，不是理解的前提。

第 40 个 dsh 插件。上游方法论来自独立 skill「漫画面讲故事」（[comic-story-video](https://github.com/liangdabiao/comic-story-video)），本插件把它收编为随包 skill + Python 引擎快照 + 工具编排 + 面板工作台。

## 它和普通讲解片的区别

| | 普通讲解片 | 这套方法 |
|---|---|---|
| 图是什么 | 插图 / 背景板 | **分镜**：人物在指、在躲、在僵住 |
| 台词在哪 | 底部字幕条，声音不念 | **念白念出来，气泡再写一遍**，气泡指着说话的人 |
| 判断标准 | 旁白讲清楚了没 | **只听不看，能讲出整个故事吗** |

一句话：**声音讲事，画面加戏。**

---

## 六个工具

| 工具 | 干什么 | 关键约束 |
|---|---|---|
| `comic_project` | init 建项目（拷 story.json 模板）/ read 读全状态 / status 查制作进度+日志 / list 列项目 | story.json 内容**永远由模型按 skill 写**，工具不覆盖 |
| `comic_check` | 机械事故预检三段（script / image / render） | **只拦「跑不跑得起来」**：缺念白、气泡出画、图空白或涂黑；文案好坏脚本判不了，靠连读自查 |
| `comic_prompts` | 出图清单：没出图的 prompt 全文 + 风格锚点图 + apiz flare 命令模板 | 指纹台账：已出图且 prompt 没变的自动跳过，**防重复花钱** |
| `comic_produce` | 后台制作：配音→气泡层→净化落版→逐笔渲染→合成竖屏烧字幕 | start 立即返回，status 轮询；stop 连树杀 |
| `comic_verify` | 产物校验（可解码/时长/音轨）+ 抽两帧检查帧 | 抽帧要肉眼看：画面在动吗、底色对不对、字幕出没出画 |
| `comic_doctor` | 环境体检：Python≥3.9 + 五依赖 / ffmpeg / apiz / 锚点图 | `fix: true` 自动 pip install（首次带 ~83MB CRAFT 模型） |

## 侧栏工作台

- **概览**：顶上「填主题 → 开始创作」，一次点击建好项目目录并跳到对话；下面是**作品库**（封面 + 四步徽标 + 成片标记 + 路径）和**成片库**（每条的绝对路径、大小、播放 / 打开文件夹 / 复制路径），环境条与扫描目录在底部
- **项目详情**：四步步进器（自动算位置）、三行头卡（story_line / question / answer）、角色设定、**分镜卡**（图 + 念白全文 + 气泡 + 音频播放）、总览图（八张并排看画风漂移）、制作控制（启停 / 日志尾 3 秒轮询）、**成片播放器**（旁边直接给成片路径 + 打开文件夹 / 复制路径）+ 检查帧、预检/验收报告折叠
- **新建漫画片**：只填主题（片名、保存位置可选）→ 一次点击建目录并跳对话
- **历史不丢**：建过 / 打开过的项目记进 `$DSH_HOME/comic-story-video/settings.json` 的台账，不配扫描目录也能在作品库找到；别处的旧项目用「扫描已有目录」纳进来
- **四步出片**：方法论页（五步流程 + 十条硬规则 + 花钱在哪）
- 明暗跟随 dsh 主题

## 环境要求

| 件 | 用途 | 怎么来 |
|---|---|---|
| Python ≥3.9 | 逐笔引擎（whiteboard-animator）+ 叙事层（Pillow/numpy） | 自备；`comic_doctor` 体检并 `fix` 补依赖 |
| ffmpeg（含 libx264） | 配音后处理 / 渲染 / 合成 / 字幕 | 自备（`theme.py` 自动补常见路径） |
| apiz CLI | 出图（gpt-image-2.5-flare 图生图，约 19 积分/张）+ 配音（MiniMax 单口腔） | `npm i -g apiz` 后 `apiz login`；edge-tts 免费兜底（腔调平） |

逐笔渲染是 CPU 活，一条片子几分钟，不花积分。

## 装

```
dsh plugin --profile web add https://github.com/liangdabiao/dsh-comic-story-video
```

装完侧栏出现「漫画故事片场」。第一次用先在对话里说「跑一下 comic_doctor」确认环境。

## 跑一条片子（对话里）

```
你：用「漫画面讲故事」做一条讲 XXX 的漫画短视频，目录 D:\stories\xxx
AI：comic_doctor → comic_project init → 按 skill 写 story.json（先填三行头）
    → comic_check(script) → comic_prompts → apiz flare 逐张出图进 raw/
    → comic_check(image) → comic_produce start → status 轮询 → comic_verify
    → 交付 out/final.mp4
```

创作边界：**故事（三行头/念白/气泡/出图 prompt）归模型按 skill 写**；插件只拦机械事故、执行生成、校验产物。十条硬规则的前三条管故事、后七条管制作，全文在随包 skill 里。

## 项目目录约定

```
<项目>/
├── story.json      唯一配置：标题、三行故事、characters、每格念白/气泡/prompt
├── charts.py       信息图格的绘图函数（有 chart 格才需要）
├── raw/            生成模型出的原图 ← 出图后放进来
├── boards/ bubbles/ charts/ audio/ out/   ← 制作工具产出
└── subs.ass  _contact.png  .check.json  .verify.json  .produce.json
```

## 自检

```
node test/lib.test.mjs        # 29 用例：数据层 + 阶段推进 + 工具形状（真引擎预检含在内）
node scripts/selftest.mjs     # 包完整性 + skill 快照 + 真引擎预检 + doctor
node scripts/client-smoke.mjs # client 模块注册
node scripts/api-test.mjs     # 14 用例：面板 API（真 http 服务）
node scripts/panel-dev.mjs    # 面板开发预览 http://127.0.0.1:8923/comic-story-video/
```

## 已知边界

- **AGNES 免费出图后端**没接进工具（上游 `comic_gen.py --backend agnes` 原样保留在引擎里，要手动跑 python）；默认路线是 apiz flare。
- 出图必须**图生图**（风格锚点做参考、相似度 low）；文生图会一张一个样。
- 渲染节奏问题（画面两秒画满）修法在 `plan.json` 删 regions 重跑渲染，**不要重出图**。
- `tts.speed` 固定 1.0——节奏靠文本（垫话/重复/破折号），不靠压时间轴。

## 目录

```
dsh-comic-story-video/
├── skills/comic-story-video/   随包 skill（SKILL.md + 8 份 references 范例/方法/参数/排错）
├── engine/                     Python 引擎快照（scripts/lib/templates/assets，含风格锚点与手写字体）
├── lib/                        tools.js 六工具 · engine.py 编排 · project.js 档案 · api.js 面板接口 · store.js 扫描目录
├── lab/                        侧栏工作台（无框架，hash 路由）
└── test/  scripts/             29 单测 + 3 套冒烟 + 面板预览
```

## License

MIT。引擎上游方法论与脚本来自 liangdabiao/comic-story-video；手写字体 MaShanZheng 为 SIL OFL 授权（见 engine/assets/fonts/OFL-MaShanZheng.txt）。
