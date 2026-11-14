import type { Copy } from "./types.ts";

export const ptBR: Copy = {
  chrome: {
    kitName: "Kit de interface",
    pageNames: {
      components: "Componentes",
      states: "Estados",
    },
    themePicker: {
      label: "Tema",
      birch: "Bétula",
      tar: "Alcatrão",
      followOs: "Sistema",
    },
    languagePicker: "Idioma",
    pageIntro:
      "Todas as peças com que as telas do Vanr são montadas, nos dois temas. Nada aqui conversa com um servidor.",
  },
  sectionHeads: {
    type: {
      title: "Tipografia",
      note: "Sans de interface para o trabalho, mono para ids e logs, a serifada só em títulos.",
    },
    buttons: {
      title: "Botões",
      note: "Uma ação principal por tela. Perigo é para o que não tem volta.",
    },
    fields: {
      title: "Campos",
      note: "Rótulo, dica e erro ficam ligados ao controle.",
    },
    choices: {
      title: "Escolhas",
      note: "Caixa de seleção, interruptor e opção única, cada um com o rótulo ao lado.",
    },
    overlays: {
      title: "Camadas",
      note: "Diálogos, menus, dicas e listas de seleção abrem por cima da página.",
    },
    tabs: {
      title: "Abas",
      note: "As setas do teclado passam de uma aba para a outra.",
    },
    feedback: {
      title: "Avisos",
      note: "Os avisos fixos ficam na página; as notificações vêm e vão.",
    },
    identity: {
      title: "Pessoas e agentes",
      note: "Pessoas são redondas. Agentes levam um sigilo desenhado a partir do id.",
    },
    status: {
      title: "Situação do trabalho",
      note: "Cada situação tem um símbolo próprio, então a cor nunca é a única pista.",
    },
    surfaces: {
      title: "Superfícies",
      note: "Cartões, painéis e linhas de lista, separados por linhas, não por sombras.",
    },
    loading: {
      title: "Carregando",
      note: "Um indicador giratório para ações, esqueletos para o conteúdo que está chegando.",
    },
    empty: {
      title: "Estado vazio",
      note: "Uma tela vazia diz o que entra ali e como adicionar.",
    },
  },
  typeSpecimen: {
    headline: "Planejamento trimestral",
    paragraph:
      "O Scout redigiu as notas de versão a partir dos pull requests mesclados e está esperando a sua revisão.",
    logLine: "09:14:02  run_01JD8Q2W4X  saída 0 em 2,4 s",
  },
  buttonLabels: {
    sendMessage: "Enviar",
    saveEdits: "Salvar alterações",
    cancel: "Cancelar",
    archiveThread: "Arquivar",
    deleteRoutine: "Excluir rotina",
    retryRun: "Tentar de novo",
    approveRequest: "Aprovar",
    createTask: "Nova tarefa",
    overflowMenuName: "Mais ações",
    searchIconName: "Buscar",
  },
  agentForm: {
    nameLabel: "Nome do agente",
    nameExample: "ex.: Batedor de versões",
    nameShownInChat: "Aparece no chat ao lado do sigilo do agente.",
    promptLabel: "Instruções",
    promptExample: "O que este agente deve fazer?",
    promptMissing: "Adicione pelo menos uma instrução antes de salvar.",
    modelPickerLabel: "Modelo",
    modelPrompt: "Escolha um modelo",
    idLabel: "Id do agente",
    requiredMark: "obrigatório",
    digestChannelLabel: "Para onde deve ir o resumo semanal das tarefas concluídas pela equipe",
    digestChannelGone:
      "Este canal não existe mais ou você perdeu o acesso a ele. Escolha outro canal da lista ou peça acesso ao responsável.",
  },
  agentSettings: {
    notifyWhenDone: "Me avise quando terminar",
    notifyWhenDoneHelp: "Envia uma mensagem na conversa.",
    approveEditsAlone: "Aprovar edições de arquivo automaticamente",
    approveEditsAloneHelp: "Comandos de terminal continuam pedindo antes.",
    runCadence: "Agenda de execução",
    everyHourOption: "A cada hora",
    everyMorningOption: "Todo dia às 9h",
    byHandOption: "Só quando iniciada manualmente",
    shelvedRoutinesOption: "Rotinas arquivadas",
  },
  renameDialog: {
    trigger: "Renomear agente",
    heading: "Renomear agente",
    explanation: "O novo nome aparece em todo lugar onde o agente aparece.",
    closeButton: "Fechar",
  },
  deleteDialog: {
    trigger: "Excluir rotina",
    question: "Excluir a rotina “Resumo semanal”?",
    consequence: "O histórico de execuções vai junto. Não dá para desfazer.",
    confirmButton: "Excluir rotina",
  },
  threadMenu: {
    trigger: "Ações da conversa",
    groupName: "Conversa",
    renameThread: "Renomear",
    duplicateThread: "Duplicar",
    pinThread: "Fixar na barra lateral",
    deleteThread: "Excluir conversa",
    rightClickTarget: "Clique com o botão direito nesta mensagem para ver o menu",
    openEveryOverlay: "Abrir todas as camadas de uma vez",
  },
  copyIdTooltip: {
    buttonName: "Copiar id da execução",
    hint: "Copia run_01JD8Q2W4X",
  },
  workspaceTabs: {
    labels: {
      chat: "Chat",
      tasks: "Tarefas",
      schedules: "Rotinas",
      knowledgeBase: "Wiki",
    },
    panels: {
      chat: "Conversas com pessoas e agentes.",
      tasks: "Trabalho atribuído a você ou a um agente.",
      schedules: "Trabalhos que rodam numa agenda.",
      knowledgeBase: "Páginas que o espaço de trabalho inteiro pode editar.",
    },
  },
  notifications: {
    regionName: "Notificações",
    dismissButton: "Dispensar",
    showPrefix: "Mostrar",
    queueFour: "Enfileirar quatro",
    undoButton: "Desfazer",
    undoExplanation: "Desfazer o arquivamento da conversa",
    samples: {
      info: {
        title: "O Scout pegou a tarefa",
        description: "Costuma levar alguns minutos.",
      },
      success: {
        title: "Alterações salvas",
        description: "Todo mundo no espaço de trabalho já vê o novo nome.",
      },
      warning: {
        title: "O Ledger está esperando aprovação",
        description: "Ele quer rodar um comando no terminal.",
      },
      danger: {
        title: "A execução falhou",
        description: "O conector respondeu 401. Reconecte e tente de novo.",
      },
    },
  },
  noticeSamples: {
    info: {
      title: "Os agentes podem ler esta página",
      body: "Tudo o que for escrito aqui fica disponível para todos os agentes do espaço de trabalho.",
    },
    success: {
      title: "Conector pronto",
      body: "O GitHub está conectado. As issues novas aparecem em Tarefas.",
    },
    warning: {
      title: "Precisa de aprovação",
      body: "O Ledger quer apagar 14 arquivos em /relatorios. Confira a lista antes.",
    },
    danger: {
      title: "Rotina interrompida",
      body: "Três execuções seguidas falharam. Corrija as credenciais e retome a rotina.",
    },
  },
  statusLabels: {
    running: "Rodando",
    "awaiting-approval": "Precisa de aprovação",
    "awaiting-reply": "Esperando resposta",
    failed: "Falhou",
    done: "Concluído",
    paused: "Pausado",
  },
  filterTags: {
    designTopic: "Design",
    highPriority: "Urgente",
    assignedToMe: "Atribuídas a mim",
    removeButtonName: (label) => `Remover ${label}`,
    longCustomerTopic: "Integração e migração de clientes corporativos",
  },
  surfaceSamples: {
    digestName: "Resumo semanal",
    digestCadence: "Roda toda segunda às 9h e publica em #equipe.",
    runLogHeading: "Log da execução",
    taskTitles: [
      "Redigir notas de versão",
      "Fazer a triagem das issues novas",
      "Conciliar as faturas do mês",
    ],
  },
  emptyRoutines: {
    heading: "Nenhuma rotina ainda",
    explanation: "Rotinas rodam um agente numa agenda, como um resumo diário das tarefas em aberto.",
    createButton: "Nova rotina",
  },
  loadingSample: {
    threadsLoading: "Carregando conversas",
  },
  stateMatrix: {
    columnNames: {
      default: "Padrão",
      hover: "Sob o cursor",
      focus: "Foco",
      active: "Pressionado",
      disabled: "Desabilitado",
      loading: "Carregando",
      error: "Erro",
    },
    notApplicable: "n/a",
    longTextHeading: "Texto longo",
    longSampleText:
      "Responsabilidades, configurações e acompanhamento das notificações automáticas de reconciliação intercompanhias",
  },
};
