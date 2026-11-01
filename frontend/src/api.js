import axios from "axios";
// 统一配置后端请求客户端。
export const client = axios.create({ baseURL: "", timeout: 0 });
// Preserve the existing response/error contracts while using Axios for all API calls.
// 提供与 fetch 调用方式兼容的接口。
export async function apiFetch(url, options = {}) {
  const response = await client.request({
    url,
    method: options.method || "GET",
    data: options.body,
    headers: options.headers,
    signal: options.signal,
    responseType: "text",
    transformResponse: [(value) => value],
    validateStatus: () => true,
  });
  return new Response(response.data, {
    status: response.status,
    headers: response.headers,
  });
}
