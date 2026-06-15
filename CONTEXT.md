### A. The Pre-Travel Vault & Asymmetric Split-Escrow
- **Direct Wallet Vault Routing:** Client payments bypass external intermediaries and target the driver's localized KONA internal storage wallet instantly upon ride booking confirmation.
- **Asymmetric Payout Splitting:** On verified trip completion, the escrow architecture automatically executes a backend ledger math sequence to divide the raw fare transaction into two parallel, immediate real-account allocations:
  * **Driver Share (- %):** Transferred into the driver's active cash-out ledger balance.
  * **KONA Commission (- %):** Transferred into the platform's primary treasury operational account.
- **Automated Reversals:** If an allocated booking times out or fails matching parameters, 100% of the locked payment value is auto-reversed straight to the original client payment node without platform processing fees.

### B. Dynamic Order Lockout & Predictive Allocation Filters
- **Absolute Order Lockout:** An active driver is structurally blocked from receiving, bidding on, or viewing subsequent marketplace offers until their active order lifecycle drops into a complete 'Settled' state.
- **State-Driven Exemption Windows:** The System Order Tracker continuously tracks real-time progress via two metric counters:
  * `Time_To_Complete` (Estimated minutes remaining based on regional velocity profiles)
  * `Km_Remained` (Calculated distance remaining to destination H3 polygon coordinates)
  If the active metrics drop below strict thresholds, the backend opens a predictive window allowing the driver to bid on incoming connecting fares.
- **Ubiquitous Fallback Dispatching:** If no predictive matches are made, the allocation engine filters and routes the trip to all physically nearby available drivers within the order's local H3 hexagon perimeter, regardless of external bidding queues.