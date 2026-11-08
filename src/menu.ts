import pc from 'picocolors';

export const theme = {
  prefix: '', icon: { cursor: pc.cyan('❯') },
  style: { message: () => '', highlight: (text: string) => pc.bold(text),
    keysHelpTip: () => pc.dim('↑↓ перемещение • Enter выбрать • Ctrl+C выход'),
  },
};
export const context = { clearPromptOnDone: true };
