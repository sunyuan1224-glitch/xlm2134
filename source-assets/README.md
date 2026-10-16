# 素材原件

**不参与打包**的源素材放这里——是「人给的东西」，产物在 `src/assets/` 与 `build/`。
放在这里是为了别让它们散在仓库根目录。

| 文件 | 是什么 | 谁用它 | 产物 |
|---|---|---|---|
| `widget-girl.png` | 挂件人物立绘原件（1254×1254，黑底不透明，人工提供的免费素材） | `scripts/prepare-widget-image.py` 抠图+缩图 | `src/assets/widget-girl.png` |
| `icon-master.png` | 应用图标母版（512×512 满幅方形插画） | `scripts/build-icons.py` 套圆角蒙版 | `build/icon.png`、`build/icon.ico` |

两者的重新生成命令：

```bash
python3 scripts/prepare-widget-image.py source-assets/widget-girl.png src/assets/widget-girl.png 400
npm run icons
```

音效没有原件放这里：`002.mp3` 与随包分发的 `src/assets/duck-squeak.mp3` 逐字节相同
（md5 一致），重复留一份没有意义，原件就是它本身。
