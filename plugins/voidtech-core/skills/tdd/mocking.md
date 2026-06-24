# 何时该 mock

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

只在**系统边界**处 mock：

- 外部 API（支付、邮件等）
- 数据库（有时——优先用测试库）
- 时间/随机性
- 文件系统（有时）

不要 mock：

- 你自己的类/模块
- 内部协作者
- 任何由当前代码库控制且可以直接测试的模块

## 为可 mock 性而设计

在系统边界处，设计易于 mock 的接口：

**1. 使用依赖注入**

把外部依赖传进来，而不是在内部创建：

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. 优先 SDK 风格的接口，而非通用 fetcher**

为每个外部操作创建专用函数，而不是用一个带条件逻辑的通用函数：

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

SDK 方式意味着：
- 每个 mock 返回固定的数据结构
- 测试初始化里没有条件逻辑
- 更容易看出某个测试调用了哪些端点
- 每个端点都有类型安全
