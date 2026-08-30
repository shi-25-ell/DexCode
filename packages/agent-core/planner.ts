type Context = {
  prompt: string;
  selectedFile: string | null;
};

export function createPlanner() {
  return {
    plan(context: Context) {
      return {
        goal: context.prompt,
        selectedFile: context.selectedFile,
        notes: ['分析需求', '确定相关文件', '决定是否需要工具调用'],
      };
    },
  };
}
