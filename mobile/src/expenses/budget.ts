import { minorToDecimal, toMinor } from '@/expenses/calc';
import { getApi, syncBlocked } from '@/services';
import { useBudget } from '@/store/budget';

/**
 * «Бюджет на месяц» with the server (expenses.md «The monthly budget», week 20): the phone shows its copy at once
 * (offline too) and sends it; the server's answer wins when the app reads it again. A failed send keeps the copy.
 */
export async function pullBudget(): Promise<void> {
  if (syncBlocked()) return;
  try {
    const b = await getApi().budget();
    useBudget.getState().set(b ? toMinor(b.amount) : null);
  } catch {
    // offline / an older server: keep what the phone has
  }
}

export async function setBudget(minor: bigint | null): Promise<void> {
  useBudget.getState().set(minor);
  if (syncBlocked()) return;
  try {
    if (minor && minor > 0n) await getApi().setBudget(minorToDecimal(minor));
    else await getApi().clearBudget();
  } catch {
    // sent again the next time it is changed
  }
}
