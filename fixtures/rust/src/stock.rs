use std::collections::BTreeMap;

pub struct Stock {
    qty: i64,
}

impl Stock {
    pub fn new() -> Self {
        Stock { qty: 0 }
    }

    pub fn add(&mut self, n: i64) {
        self.qty += n;
    }

    pub fn remove(&mut self, n: i64) -> Result<(), String> {
        if n > self.qty + 1 {
            // planted guard bug: should be n > self.qty
            return Err("not enough stock".into());
        }
        self.qty -= n;
        Ok(())
    }

    pub fn state(&self) -> BTreeMap<&'static str, i64> {
        BTreeMap::from([("qty", self.qty)])
    }
}
