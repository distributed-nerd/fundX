import type { Bank } from "@/lib/types";

/**
 * What is left of the mock layer.
 *
 * The persistence is gone — every read is a server call now, so a second copy of the
 * user's money in localStorage was only a way for the two to disagree. What remains is an
 * offline bank list and a cleanup for state earlier builds wrote.
 */

const KEY = "fundx.state.v1";

export const BANKS: Bank[] = [
  { code: "999992", name: "OPay", fintech: true },
  { code: "50515", name: "Moniepoint MFB", fintech: true },
  { code: "999991", name: "PalmPay", fintech: true },
  { code: "50211", name: "Kuda Bank", fintech: true },
  { code: "51318", name: "FairMoney MFB", fintech: true },
  { code: "565", name: "Carbon", fintech: true },
  { code: "51310", name: "Sparkle Microfinance Bank", fintech: true },
  { code: "50304", name: "Mint MFB", fintech: true },
  { code: "566", name: "VFD Microfinance Bank", fintech: true },
  { code: "100", name: "SunTrust Bank", fintech: true },
  { code: "044", name: "Access Bank" },
  { code: "063", name: "Access Bank (Diamond)" },
  { code: "035", name: "Wema Bank" },
  { code: "050", name: "Ecobank Nigeria" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "214", name: "First City Monument Bank" },
  { code: "058", name: "Guaranty Trust Bank" },
  { code: "030", name: "Heritage Bank" },
  { code: "082", name: "Keystone Bank" },
  { code: "076", name: "Polaris Bank" },
  { code: "101", name: "Providus Bank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "068", name: "Standard Chartered Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "102", name: "Titan Trust Bank" },
  { code: "033", name: "United Bank For Africa" },
  { code: "032", name: "Union Bank of Nigeria" },
  { code: "215", name: "Unity Bank" },
  { code: "057", name: "Zenith Bank" },
  { code: "023", name: "Citibank Nigeria" },
  { code: "104", name: "Parallex Bank" },
  { code: "00103", name: "Globus Bank" },
  { code: "301", name: "Jaiz Bank" },
  { code: "302", name: "TAJBank" },
  { code: "303", name: "Lotus Bank" },
  { code: "125", name: "Rubies MFB" },
];


export function clear(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
