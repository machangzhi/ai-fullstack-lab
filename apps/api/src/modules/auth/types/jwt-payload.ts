/**
 * 文件作用：JWT payload 的类型定义。
 *
 * 关键概念：
 * 1. payload 是**明文**的（base64 编码，不是加密），任何拿到 Token 的人都能解开看到。
 *    所以这里只放不可变、非敏感的信息：用户 ID 与角色。
 * 2. 绝不能放密码、手机号、邮箱验证码这类敏感数据。
 * 3. sub（subject）是 JWT 规范里"主体"的标准字段，约定用来放用户 ID。
 * 4. type 用来区分两种令牌：access 可访问接口，refresh 只能换新令牌。
 *    没有它，攻击者可以拿短期的 access token 去调刷新接口，变相延长寿命。
 */

export interface JwtPayload {
  /** 用户 ID（JWT 标准字段名，代表 token 的主体） */
  sub: string;
  /** 用户角色，用于 RBAC 判断 */
  role: 'ADMIN' | 'MEMBER';
  /** 令牌类型：access 访问接口，refresh 只用于刷新 */
  type: 'access' | 'refresh';
  /** 签发时间（秒级时间戳），JWT 库自动填充 */
  iat?: number;
  /** 过期时间（秒级时间戳），JWT 库自动填充 */
  exp?: number;
}
