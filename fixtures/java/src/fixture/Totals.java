package fixture;

import java.util.List;

public class Totals {
  public static long total(List<Long> xs) {
    long t = 0;
    for (long x : xs) t += x;
    return t;
  }

  public static long totalBuggy(int[] xs) {
    long t = 0;
    for (int i = 0; i < xs.length - 1; i++) t += xs[i]; // planted off-by-one: skips the last item
    return t;
  }
}
