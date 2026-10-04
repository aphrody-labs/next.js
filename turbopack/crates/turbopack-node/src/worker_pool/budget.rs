use std::sync::Arc;

use tokio::sync::Semaphore;

/// Reservations belong to the worker pool, rather than each facade using it.
/// The limit is immutable: changing a limit while permits are held would require
/// accounting for permits that return after the change.
pub(crate) struct WorkerPoolBudget {
    limit: usize,
    pub(crate) concurrency: Arc<Semaphore>,
    pub(crate) bootup: Arc<Semaphore>,
}

impl WorkerPoolBudget {
    pub(crate) fn new(limit: usize) -> Result<Self, String> {
        if limit == 0 || limit > Semaphore::MAX_PERMITS {
            return Err("Worker pool concurrency limit is out of range".to_owned());
        }
        Ok(Self {
            limit,
            concurrency: Arc::new(Semaphore::new(limit)),
            bootup: Arc::new(Semaphore::new(1)),
        })
    }

    pub(crate) fn ensure_compatible(&self, limit: usize) -> Result<(), String> {
        if limit != self.limit {
            return Err(format!(
                "Worker pool already uses a concurrency limit of {}; requested {limit}",
                self.limit
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        sync::Arc,
        task::{Context, Poll, Waker},
    };

    use tokio::sync::Semaphore;

    use super::WorkerPoolBudget;

    #[test]
    fn rejects_invalid_and_incompatible_limits_without_changing_reservations() {
        assert!(WorkerPoolBudget::new(0).is_err());
        assert!(WorkerPoolBudget::new(Semaphore::MAX_PERMITS + 1).is_err());
        let budget = WorkerPoolBudget::new(2).unwrap();
        let reservation = budget.concurrency.clone().try_acquire_owned().unwrap();
        assert!(budget.ensure_compatible(2).is_ok());
        assert!(budget.ensure_compatible(1).is_err());
        assert!(budget.ensure_compatible(3).is_err());
        assert_eq!(budget.concurrency.available_permits(), 1);
        drop(reservation);
        assert_eq!(budget.concurrency.available_permits(), 2);
    }

    #[test]
    fn two_facades_share_the_limit_and_return_reservations_on_drop() {
        let first = Arc::new(WorkerPoolBudget::new(2).unwrap());
        let second = first.clone();
        let first_reservation = first.concurrency.clone().try_acquire_owned().unwrap();
        let second_reservation = second.concurrency.clone().try_acquire_owned().unwrap();
        assert_eq!(first.concurrency.available_permits(), 0);
        assert!(second.concurrency.clone().try_acquire_owned().is_err());

        let mut pending = Box::pin(second.concurrency.clone().acquire_owned());
        let mut context = Context::from_waker(Waker::noop());
        assert!(pending.as_mut().poll(&mut context).is_pending());
        drop(first_reservation);
        let Poll::Ready(Ok(replacement)) = pending.as_mut().poll(&mut context) else {
            panic!("returned reservation did not reach the other facade");
        };
        assert_eq!(first.concurrency.available_permits(), 0);
        drop(second_reservation);
        drop(replacement);
        assert_eq!(first.concurrency.available_permits(), 2);
    }

    #[test]
    fn cancelling_a_pending_reservation_preserves_the_shared_limit() {
        let budget = Arc::new(WorkerPoolBudget::new(1).unwrap());
        let reservation = budget.concurrency.clone().try_acquire_owned().unwrap();
        let facade = budget.clone();
        let mut pending = Box::pin(facade.concurrency.clone().acquire_owned());
        let mut context = Context::from_waker(Waker::noop());
        assert!(pending.as_mut().poll(&mut context).is_pending());
        drop(pending);
        drop(reservation);
        assert_eq!(budget.concurrency.available_permits(), 1);
        let replacement = facade.concurrency.clone().try_acquire_owned().unwrap();
        assert_eq!(budget.concurrency.available_permits(), 0);
        drop(replacement);
        assert_eq!(budget.concurrency.available_permits(), 1);
    }

    #[test]
    fn cancelling_after_a_permit_is_assigned_returns_it_to_the_pool() {
        let budget = WorkerPoolBudget::new(1).unwrap();
        let reservation = budget.concurrency.clone().try_acquire_owned().unwrap();
        let mut pending = Box::pin(budget.concurrency.clone().acquire_owned());
        let mut context = Context::from_waker(Waker::noop());
        assert!(pending.as_mut().poll(&mut context).is_pending());
        drop(reservation);
        // The semaphore assigned its only permit to the waiter, which has not
        // yet polled again to turn that assignment into an owned reservation.
        assert_eq!(budget.concurrency.available_permits(), 0);
        drop(pending);
        assert_eq!(budget.concurrency.available_permits(), 1);
        assert!(budget.concurrency.clone().try_acquire_owned().is_ok());
    }

    #[test]
    fn two_facades_share_bootup_reservations() {
        let first = Arc::new(WorkerPoolBudget::new(2).unwrap());
        let second = first.clone();
        let reservation = first.bootup.clone().try_acquire_owned().unwrap();
        assert_eq!(second.bootup.available_permits(), 0);
        let mut pending = Box::pin(second.bootup.clone().acquire_owned());
        let mut context = Context::from_waker(Waker::noop());
        assert!(pending.as_mut().poll(&mut context).is_pending());
        drop(reservation);
        let Poll::Ready(Ok(replacement)) = pending.as_mut().poll(&mut context) else {
            panic!("returned bootup reservation did not reach the other facade");
        };
        drop(replacement);
        assert_eq!(first.bootup.available_permits(), 1);
    }
}
