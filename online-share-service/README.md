# 寻品分享保存接口

此目录部署到 Netlify 的 Free 计划，商品在浏览器中加密，后台仅接收不可变的加密快照。分享没有设置到期时间，site-wide Blobs 存储会跨代码部署保留。

`POST /api/shares` 接收 `{id,content}`。相同内容可安全重试，同一标识下的不同内容会被拒绝。`GET /api/shares/:id` 返回密文。界面在 GitHub 工作台，买手和收件人直接使用分享网址。

发布只选 Free 计划。Free 有硬额度上限且无自动充值，额度用完时暂停服务。当前包固定使用 `@netlify/blobs 11.1.11`，需要 Node 22.12 或更高版本。

部署前执行 `pnpm install` 和 `pnpm build`。构建将两个函数与依赖一起打包到 `dist/functions`，部署使用这个目录。

本地执行 `pnpm test` 验证接口及独立打包结果。接口测试使用内存存储和虚构密文，打包测试把函数复制到不含依赖的临时目录验证加载和路由配置。
