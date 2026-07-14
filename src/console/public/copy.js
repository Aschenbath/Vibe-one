export const STATUS_COPY = { queued: '排队中', planning: '理解需求', building: '生成产品', verifying: '构建验证', visual: '视觉校验', repairing: '自动修复', success: '交付完成', planned: '规划完成', failed: '运行失败' };
export const ERROR_COPY = {
  INPUT_REQUIRED: '请填写需求描述或上传至少一张参考图。',
  REFERENCE_TYPE_UNSUPPORTED: '仅支持 PNG、JPEG 和 WebP 图片。',
  REFERENCE_TOO_LARGE: '单张参考图不能超过 6 MiB。',
  REFERENCE_TOTAL_EXCEEDED: '参考图总大小不能超过 18 MiB。',
  REFERENCE_COUNT_EXCEEDED: '最多上传 4 张参考图。',
  BODY_TOO_LARGE: '提交内容过大，请减少参考图数量或尺寸。',
  VISION_UNSUPPORTED: '当前模型或接口不支持图片理解，请更换支持视觉输入的模型。',
  API_KEY_REQUIRED: '请先在运行设置中填写本次会话使用的 API Key。',
  JOB_ACTIVE: '已有任务正在运行，请等待它完成。',
  INTERNAL_ERROR: '本地工作台暂时无法完成请求，请查看事件记录。',
};
export const EVENT_COPY = { 'plan:start': '正在理解需求与参考图', 'plan:done': '产品规格已经生成', 'design:done': '设计规格已经批准', 'build:start': '正在生成产品初稿', 'build:done': '产品文件生成完成', 'quality:audit': '正在执行 UI 质量验收', 'visual:compare': '正在比较视觉一致性', 'polish:start': '正在抛光成品候选', 'polish:applied': '成品候选已应用', 'polish:failed': '成品候选未通过复验', 'fix:start': '正在根据失败证据修复', 'fix:applied': '修复文件已经应用', review: '机械验收完成', 'report:written': '交付报告已经生成', fatal: '运行发生错误' };
