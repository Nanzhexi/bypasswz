# bypasswz

GSXT 企业信用存档助手，Chrome Manifest V3 扩展。

## 安装与测试

需要 Node.js 20 或更新版本。

```sh
npm ci
npm run install:browser
npm test
npm run test:browser
npm run test:archive
```

在 Chrome 扩展管理页面启用开发者模式，加载 `chrome_extension`。
输入企业名称，每行一家；已登录时可留空账号密码。
插件表单会将填写内容保存在扩展本地数据中，可通过“清除已保存信息”移除。
首次归档会请求跨标签截图权限。

## 当前状态

- Mac 基础、浏览器及模拟归档测试通过：44 个栏目、12 张 PNG。
- 真实官网登录与企业详情访问已验证。
- 真实完整归档尚未验证成功；现有截图存在目录布局问题。
- 验证码仍需交互处理，未实现无人值守验证码识别。
- 当前产物为 PNG；PDF 和原生日期/网址页眉页脚尚未实现。

最新代码优先复用名称完全匹配的已打开企业详情，并优先点击官网栏目导航的叶子控件。
