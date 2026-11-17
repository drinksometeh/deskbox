# DeskBox

Windows 桌面整理盒子，類似 Coodesker／Fences。用 Electron 寫成，Windows 11。

- 半透明毛玻璃盒子，固定在桌面底層，`Win+D` 不會被收起來
- 盒子內可分頁、收合、鎖定位置、切換圖示／列表顯示、框選多個項目
- 分頁可以映射到任何資料夾
- 自動整理桌面：遊戲捷徑、其他捷徑、一般檔案按類型收進對應的盒子
- 雙擊桌面空白處隱藏／顯示桌面圖示和盒子
- 開機自動啟動（工作列圖示選單）

盒子裡的東西是真的檔案，放在 `%USERPROFILE%\DeskBox\` 底下，盒子選單的「全部移回桌面」可以放回去。

**解除安裝前**，先在每個盒子的選單按「全部移回桌面」。解除安裝不會動到 `%USERPROFILE%\DeskBox\`，沒移回去的東西會留在那個資料夾裡，不會消失，但桌面上看不到。

**桌面有用 OneDrive 同步的話**（很多 Windows 11 電腦預設如此），自動整理會把檔案從 OneDrive 的桌面搬到 `%USERPROFILE%\DeskBox\`，OneDrive 會當成刪除，其他裝置上的桌面也會少掉這些檔案。這種情況請先關掉工作列圖示選單的「自動整理桌面」。

## 安裝

到 [Releases](https://github.com/drinksometeh/deskbox/releases) 下載 `DeskBox-Setup-x.x.x.exe` 執行即可，裝好會自動開啟，之後開機自動啟動。安裝檔沒有數位簽章，Windows 可能跳出「Windows 已保護您的電腦」，按「其他資訊」→「仍要執行」。

## 開發

```bash
npm install
npm start
```

測試：`npm test`（單元測試）、`npm run e2e`（端對端，會開一個獨立的 DeskBox 用暫存資料夾測試，不會動到真的桌面）

## 授權

MIT + [Commons Clause](https://commonsclause.com/)：可以免費使用、修改和分享，但**不得販售**，也不得拿它來收費提供產品或服務。詳見 [LICENSE](LICENSE)。
