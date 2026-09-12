const actions: Record<string, string> = {
  "admin.request": "Удирдлагын хүсэлт",
  "admin.authorization": "Хандах эрхийн шалгалт",
  "admin.bootstrap_owner": "Эзэмшигчийн анхны эрх үүсгэх",
  "admin.operator.create": "Оператор нэмэх",
  "admin.operator.role_update": "Операторын эрх өөрчлөх",
  "admin.operator.suspend": "Оператор түдгэлзүүлэх",
  "admin.operator.reactivate": "Оператор дахин идэвхжүүлэх",
  "admin.operator.mutation": "Операторын мэдээлэл өөрчлөх",
  "account.suspend": "Аккаунт түдгэлзүүлэх",
  "account.reactivate": "Аккаунт дахин идэвхжүүлэх",
  "plans.update": "Багцын хязгаар шинэчлэх",
  "plans.rollback": "Багцын өмнөх хязгаарыг сэргээх",
  "support.ticket.reply": "Тусламжийн хүсэлтэд хариулах",
  "support.ticket.note": "Дотоод тэмдэглэл нэмэх",
  "support.ticket.update": "Тусламжийн хүсэлт шинэчлэх",
  "support.ticket.mutation": "Тусламжийн хүсэлт өөрчлөх",
  "payments.cancel": "Нэхэмжлэх цуцлах",
  "payments.cancel.requested": "Нэхэмжлэх цуцлах хүсэлт илгээх",
  "payments.refund": "Төлбөр буцаах",
  "payments.settle": "Мерчантын тооцоо бүртгэх",
  "payments.refund.requested": "Төлбөр буцаах хүсэлт илгээх",
  "payment_recovery.retry": "Төлбөрийн боловсруулалтыг дахин товлох",
}

const targets: Record<string, string> = {
  route: "Үйлчилгээний зам",
  platform_admin: "Оператор",
  account: "Аккаунт",
  workspace: "Ажлын орон зай",
  plan_config: "Багцын тохиргоо",
  support_ticket: "Тусламжийн хүсэлт",
  payment_invoice: "Төлбөрийн нэхэмжлэх",
  payment_recovery: "Төлбөрийн сэргээх бүртгэл",
}

const plans: Record<string, string> = {
  free: "Үнэгүй",
  basic: "Үндсэн (Basic)",
  pro: "Про (Pro)",
  max: "Дээд (Max)",
}

const paymentStates: Record<string, string> = {
  created: "Үүссэн",
  pending: "Хүлээгдэж буй",
  paid: "Төлөгдсөн",
  failed: "Амжилтгүй",
  expired: "Хугацаа дууссан",
  cancelled: "Цуцлагдсан",
  refunded: "Буцаасан",
}

export function adminAuditActionLabel(action: string) {
  return Object.hasOwn(actions, action) ? actions[action] : "Бусад үйлдэл"
}

export function adminAuditTargetLabel(target: string | null) {
  if (!target) return "-"
  return Object.hasOwn(targets, target) ? targets[target] : `Бусад объект (${target})`
}

export function adminPlanLabel(plan: string | null) {
  if (!plan) return "-"
  return Object.hasOwn(plans, plan) ? plans[plan] : `Тодорхойгүй багц (${plan})`
}

export function adminPaymentStatusLabel(status: string | null) {
  if (!status) return "-"
  return Object.hasOwn(paymentStates, status) ? paymentStates[status] : `Тодорхойгүй төлөв (${status})`
}
