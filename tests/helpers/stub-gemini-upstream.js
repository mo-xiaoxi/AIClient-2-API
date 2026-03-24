/**
 * Gemini 兼容上游 stub（与 OpenAI stub 共用同一 handler：generateContent / streamGenerateContent）。
 * 实际实现见 start-mock-upstream-stack-custom.js 的 defaultStubHandler。
 */
export { defaultStubHandler as geminiCompatibleStubHandler } from './start-mock-upstream-stack-custom.js';
