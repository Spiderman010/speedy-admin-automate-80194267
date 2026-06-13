export const formatEuro = (n: number) =>
  new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
  }).format(n);

export const formatGetal = (n: number) =>
  n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const formatDatumNL = (iso: string) =>
  new Date(iso).toLocaleDateString("nl-NL");
