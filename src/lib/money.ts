/** "32 000 KGS" (Russian grouping, no decimals unless needed). */
export function formatMoney(amount: number, currency = "KGS"): string {
  const s = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(amount).replace(/ /g, " ");
  return `${s} ${currency}`;
}
