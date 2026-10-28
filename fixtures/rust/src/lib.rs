pub mod stock;

pub fn total(xs: Vec<i64>) -> i64 {
    xs.iter().sum()
}

pub fn total_buggy(xs: Vec<i64>) -> i64 {
    let mut t = 0;
    for i in 0..xs.len().saturating_sub(1) {
        // planted off-by-one: skips the last item
        t += xs[i];
    }
    t
}
