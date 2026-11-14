import type { TranslationOf } from "../../i18n/format.ts";
import type en from "./en.ts";

export default {
  fallback: "Algo deu errado. Tente de novo.",
  "network.unreachable": "Não foi possível falar com o Vanr. Confira sua conexão e tente de novo.",
  "response.malformed": "O servidor respondeu de um jeito que esta versão não entende. Recarregue a página.",
  "client.unexpected": "Algo deu errado nesta página. Tente de novo.",
  unauthorized: "Sua sessão terminou. Entre de novo.",
  forbidden: "Você não tem permissão para fazer isso.",
  not_found: "Isso não existe mais.",
  invalid_request: "O servidor não aceitou esse pedido.",
  internal: "O servidor encontrou um problema. Tente de novo.",
  http_503: "O servidor está ocupado.",
  invalid_email_or_password: "Esse e-mail e essa senha não combinam.",
  user_already_exists: "Já existe uma conta com este e-mail. Entre com ela.",
  user_already_exists_use_another_email: "Já existe uma conta com este e-mail. Entre com ela.",
  password_too_short: "Use pelo menos 8 caracteres.",
  password_too_long: "Use no máximo 128 caracteres.",
  invalid_token: "Este link venceu ou já foi usado.",
  signup_closed: "Aqui o cadastro é por convite. Peça um a quem administra o espaço de trabalho.",
  signup_busy: "Outro cadastro está criando a primeira conta.",
  already_member: "Esta pessoa já é membro.",
  "invitation.used": "Este convite já foi usado.",
  "invitation.wrong_email": "Este convite é para outro e-mail.",
} satisfies TranslationOf<typeof en>;
