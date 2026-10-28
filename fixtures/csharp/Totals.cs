namespace Fixture;

public static class Totals
{
    public static long Total(List<long> xs) => xs.Sum();

    public static long TotalBuggy(int[] xs)
    {
        long t = 0;
        for (var i = 0; i < xs.Length - 1; i++) t += xs[i]; // planted off-by-one: skips the last item
        return t;
    }
}
