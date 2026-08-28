import { invoke, Channel } from '@tauri-apps/api/core';

export interface UniformDeclDto {
  name: string;
  glsl_type: string;
  description?: string | null;
}

export interface TemplateSuggestionDto {
  name: string;
  description: string;
  category: string;
  preview_thumbnail: string;
  code: string;
}

export interface ParamDocDto {
  name: string;
  range: string;
  effect: string;
  default: string;
}

export interface ShaderDocDto {
  inline_comments: string;
  algorithm_explanation: string;
  parameters: ParamDocDto[];
  performance_notes?: string | null;
}

export interface ErrorFeedbackDto {
  phase: string;
  message: string;
  line?: number | null;
  suggestion: string;
}

export interface CompileErrorDto {
  line: number;
  column: number;
  message: string;
}

/** M2：编译通过后 wgpu 离屏渲染的首帧报告（§5.3） */
export interface RenderReportDto {
  success: boolean;
  unavailable_reason?: string | null;
  errors?: string[];
  is_black_frame: boolean;
  is_white_frame: boolean;
  avg_brightness: number;
  coverage: number;
  render_time_ms: number;
  thumbnail_base64?: string | null;
}

export interface ValidationViewDto {
  status: string;
  errors: CompileErrorDto[];
  warnings: string[];
  fix_attempts: number;
  note?: string | null;
  render?: RenderReportDto | null;
}

export interface ChatResponseDto {
  text: string;
  phase_id: string;
  phase: string;
  intent: string;
  parse_ok: boolean;
  has_code: boolean;
  code_fragment?: string;
  vertex_shader?: string;
  suggestions: TemplateSuggestionDto[];
  clarification?: string;
  documentation?: ShaderDocDto;
  error_feedback?: ErrorFeedbackDto;
  validation?: ValidationViewDto;
}

export interface PhaseViewDto {
  id: string;
  name: string;
}

/** M3：确定性模板选型桥接结果 */
export interface TemplateAdoptDto {
  text: string;
  template_name: string;
  category: string;
  phase_id: string;
  phase: string;
  intent: string;
  has_code: boolean;
  code_fragment?: string;
}

/** M6d：服务商预设（对应后端 config::ProviderPreset，models[0] 为该服务商默认模型） */
export interface ProviderPresetDto {
  id: string;
  label: string;
  base_url: string;
  models: string[];
  local: boolean;
}

export interface AgentConfigViewDto {
  configured: boolean;
  base_url: string;
  model: string;
  temperature: number;
  max_tokens: number;
  api_key_hint?: string | null;
  presets: ProviderPresetDto[];
}

export interface SetAgentConfigArgsDto {
  api_key?: string;
  base_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function sendChat(message: string): Promise<ChatResponseDto> {
  return invoke<ChatResponseDto>('chat', { message });
}

/** M5：流式回合的增量事件（对应后端 ChatStreamEvent：serde tag=type + snake_case） */
export type ChatStreamEventDto =
  | { type: 'delta'; text: string }
  | { type: 'reset' };

/** M5：走 chat_stream 命令，LLM 文本增量经 Channel 实时回调；返回值仍为完整富响应 */
export async function sendChatStream(
  message: string,
  onEvent: (event: ChatStreamEventDto) => void
): Promise<ChatResponseDto> {
  const channel = new Channel<ChatStreamEventDto>();
  channel.onmessage = onEvent;
  return invoke<ChatResponseDto>('chat_stream', { message, onEvent: channel });
}

export async function fetchPhase(): Promise<PhaseViewDto> {
  return invoke<PhaseViewDto>('get_phase');
}

export async function resetSession(): Promise<void> {
  return invoke<void>('reset_session');
}

export async function fetchAgentConfig(): Promise<AgentConfigViewDto> {
  return invoke<AgentConfigViewDto>('get_agent_config');
}

export async function saveAgentConfig(args: SetAgentConfigArgsDto): Promise<AgentConfigViewDto> {
  return invoke<AgentConfigViewDto>('set_agent_config', { args });
}

/** M3：确定性选型桥接——跳过 LLM 轮次，后端直接落库模板代码并推进阶段 */
export async function adoptTemplate(name: string): Promise<TemplateAdoptDto> {
  return invoke<TemplateAdoptDto>('select_template', { name });
}

/** M6c：自定义模板视图（对应后端 ipc::chat::UserTemplateView） */
export interface UserTemplateViewDto {
  slug: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  difficulty: string;
  code: string;
}

/** M6c：保存自定义模板入参（对应后端 SaveUserTemplateArgs） */
export interface SaveUserTemplateArgsDto {
  name: string;
  description?: string;
  tags?: string[];
  difficulty?: string;
  uniforms?: string[];
  code: string;
}

/** M6c：列出用户自定义模板（内置池之外的磁盘目录镜像） */
export async function listUserTemplates(): Promise<UserTemplateViewDto[]> {
  return invoke<UserTemplateViewDto[]>('list_user_templates');
}

/** M6c：保存（新建或同名覆盖）自定义模板；后端先做 glslang 编译预检，未通过则抛出行列详情 */
export async function saveUserTemplate(
  args: SaveUserTemplateArgsDto,
): Promise<UserTemplateViewDto> {
  return invoke<UserTemplateViewDto>('save_user_template', { args });
}

/** M6c：按 slug 删除自定义模板（slug 形如 user/xxx） */
export async function deleteUserTemplate(slug: string): Promise<void> {
  return invoke<void>('delete_user_template', { slug });
}
