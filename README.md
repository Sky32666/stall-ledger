# 档口账本

档口每日收档记账、库存和月报（损益表）的手机网页。可以在 iPhone Safari「添加到主屏幕」，像 App 一样使用。

- **记账**：拍 POS 日结单，手机上免费识别文字（Tesseract.js，不用 API key），自动填总额、现金、NETS、PayNow、外卖平台和单数，检查后保存。照片会一起存档。
- **库存**：进货（数量、总价、供应商）、盘点、报废，快没货时提醒。
- **月报**：营业额 − 食材进货 = 毛利，再减去租金、人工、水电等开支得到净利；有每日明细、星期分析、付款方式、供应商排名，可以导出 CSV 用 Excel 打开。

数据存在 Supabase（表名都以 `ledger_` 开头，跟 POS 的表分开），只有加进白名单的邮箱能登录。

## 一次性设置（Supabase）

1. **建表**：Supabase → SQL Editor → 贴上 [`supabase/migrations/20261021_stall_ledger.sql`](supabase/migrations/20261021_stall_ledger.sql) 全部内容 → Run。
2. **关掉公开注册**：Authentication → Sign In / Providers → Email → 关闭 *Allow new users to sign up*。（就算没关，没在白名单里的人也看不到任何数据。）
3. **加用户**：Authentication → Users → *Add user* → *Create new user*，填邮箱和密码，勾选 *Auto Confirm User*。
4. **加进白名单**：SQL Editor 运行
   ```sql
   insert into ledger_members (email) values ('姐姐的邮箱@example.com');
   ```

## 部署

整个文件夹是静态网站（没有服务器代码），放到任何静态托管都可以，例如 GitHub Pages、Vercel、Cloudflare Pages。必须用 **https**，否则「添加到主屏幕」和离线功能不能用。

`config.js` 里只有 Supabase 的 URL 和 **anon key**（本来就是公开的）。**绝对不要**放 service_role key。

## iPhone 安装

用 Safari 打开网址 → 分享按钮 → **添加到主屏幕**。第一次打开时登录一次，之后会记住。

## 开发

```bash
python3 -m http.server 8766 --directory stall-ledger
node --test stall-ledger/tests
```

日结单的识别规则在 [`ocr.js`](ocr.js)。如果你的 POS 日结单用的字眼不一样（例如 "Nett Amt"），在 `TOTAL_KEYS` 或 `CATEGORIES` 里加关键字，然后在 `tests/ocr.test.mjs` 加一个例子。
