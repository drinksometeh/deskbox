# DeskBox

Windows 桌面整理盒子，類似 Coodesker／Fences。用 Electron 寫成，Windows 11。

- 半透明毛玻璃盒子，固定在桌面底層，`Win+D` 不會被收起來
- 盒子內可分頁、收合、鎖定位置、切換圖示／列表顯示、框選多個項目
- 分頁可以映射到任何資料夾
- 自動整理桌面：遊戲捷徑、其他捷徑、一般檔案按類型收進對應的盒子
- 雙擊桌面空白處隱藏／顯示桌面圖示和盒子
- 開機自動啟動（工作列圖示選單）

盒子裡的東西是真的檔案，放在 `%USERPROFILE%\DeskBox\` 底下，盒子選單的「全部移回桌面」可以放回去。

## 使用

```bash
npm install
npm start
```

測試：`npm test`

## 授權

MIT + [Commons Clause](https://commonsclause.com/)：可以免費使用、修改和分享，但**不得販售**，也不得拿它來收費提供產品或服務。詳見 [LICENSE](LICENSE)。
