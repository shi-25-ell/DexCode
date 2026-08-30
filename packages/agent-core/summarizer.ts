type SummarizeInput = {
  plan: { goal?: string; selectedFile?: string | null };
  execution: { content?: string };
  review: { summary?: string; notes?: string[] };
};

export function createSummarizer() {
  return {
    summarize({ plan, execution, review }: SummarizeInput) {
      return [
        `目标：${plan.goal || '未提供'}`,
        `选中文件：${plan.selectedFile || '无'}`,
        `执行结果：${review.summary || execution.content || '无'}`,
        ...(review.notes || []),
      ].join('\n');
    },
  };
}
