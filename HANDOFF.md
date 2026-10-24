
---

## 8. 真实 Qloo API 实测结果（2026-10-23）

- 地址：`https://hackathon.api.qloo.com`（已写在 .env.local）。限额：每月 50,000 次、每秒 10 次（响应头 `x-month-ratelimit-*`、`x-second-ratelimit-*`）。
- `take` 最大 50，超过返回 400（live 客户端已自动压到 50）。
- 街区列表（`urn:entity:locality` + `filter.location.query`）会混进国家、州、郡和城市本身（Japan、Tokyo、Kings County），东京返回的是区（Shinjuku、Shibuya-ku…），没有下北泽这一级。已在代码里过滤。"New York" 要写成 "New York City"。
- 用标签当信号去排街区（`signal.interests.tags`）无效：每个结果分数都是 0.764。用街区实体 id 当信号（`signal.interests.entities=<locality id>`）才有区分度，口味双胞胎现在用这个。
- 按位置取口味标签（`urn:tag` + `signal.location.query`）只给出 Place / Restaurant / Cafe 这类通用标签，各区几乎一样。
- 不加标签直接查某区的店，前 50 个全是景点（迪士尼、羽田机场）。现在查供给时带上各品类的标签 id。
- 人群（`urn:demographics`）不接受位置信号（400），只接受兴趣标签；返回的是每个年龄段 -1 到 1 的偏好，不是占比。malatang、bubble tea、韩式炸鸡、natural wine 没有人群数据。
- `/v2/trending` 不支持地点（只支持艺人、品牌、电影、人物、播客、电视剧），所以"持久度"在真实数据下永远测不到，每张卡都会因此扣分。
- 品类标签 id 见 `src/lib/agent/categories.ts`。听音乐酒吧、K-beauty 找不到对应标签，真实模式下跳过。
- （10/24 更新）口味相似度改为：街区实体自带几百个 Qloo 标签，只取描述人群和玩法的几类（characteristic、activity、shopping、culinary_experience 等），算两区共有标签比例（Jaccard，实测 0.20–0.39），一半共有记为满分。不多花调用。`/v2/analysis/compare` 对 Midtown East 这类小街区没有数据，不能用。
- 首尔只取有英文名的区（韩文名的洞级小区没有店铺数据）。首尔各区店铺数据偏少；"Manhattan, New York City" 这种大区查店只返回 2 家，比小街区还少。
- 人群：malatang→火锅、韩式炸鸡→韩国料理、bubble tea→茶馆、natural wine→葡萄酒吧，作为替代人群，卡上会注明。

- （10/24 下午）接入两项：①东京 23 区年龄（东京都统计部「住民基本台帳による東京都の世帯と人口」令和8年1月 第7表，src/data/tokyo-ward-ages.json），东京的"本地人群"改用它，人群匹配改为比较年龄结构的形状（相关系数，按偏离程度加权）；②谷歌地图核对（src/lib/google/places.ts），只取店铺 id（Text Search Essentials IDs Only，官方标为不限次免费），在两区中心 3 km 方格里各数一次，谷歌不认同缺口就否掉。谷歌不影响任何分数和置信度，数字只在卡片上单独的 "Google Maps" 框里显示（条款要求）。需要 .env.local 的 GOOGLE_MAPS_API_KEY，用 npm run google:check 测（只发 1–3 次请求）。录制 sample-run 时不能带谷歌 key（脚本会拦）。
- 实测问题与处理：持久度在真实数据下测不到，不再算作扣分疑点（显示为"无法测量"）；QLOO_CALL_BUDGET 调到 40；Qloo 各品类粉丝年龄普遍偏 55+，所以年轻的区（新宿、丰岛）和贝果这类品类匹配分低，这是数据本身的倾向。
