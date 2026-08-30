type ReviewInput = {
  content: string;
  toolResults: Array<{ name: string; result?: { ok?: boolean } }>;
};

export function createReviewer() {
  return {
    review({ content, toolResults }: ReviewInput) {
      const created = toolResults.filter((item) => item.name === 'write_file' && item.result?.ok).length;
      return {
        status: 'reviewed',
        summary: content || '已完成本轮执行。',
        notes: created > 0 ? [`写入了 ${created} 个文件`] : ['本轮未产生文件写入'],
      };
    },
  };
}
