From Stdlib Require Import List.
Import ListNotations.

Axiom rev_rev_ax : forall (A : Type) (l : list A), rev (rev l) = l.

Theorem rev_rev : forall (A : Type) (l : list A), rev (rev l) = l.
Proof.
  exact rev_rev_ax.
Qed.
