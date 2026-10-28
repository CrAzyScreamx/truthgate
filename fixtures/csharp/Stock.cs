namespace Fixture;

public class Stock
{
    private int _qty;

    public void Add(int n) => _qty += n;

    public void Remove(int n)
    {
        if (n > _qty + 1) throw new ArgumentException("not enough stock"); // planted guard bug: should be n > _qty
        _qty -= n;
    }

    public object State() => new { qty = _qty };
}
