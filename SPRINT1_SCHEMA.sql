CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE order_status AS ENUM (
    'pending_payment',
    'escrow_locked',
    'awaiting_driver',
    'assigned',
    'en_route_pickup',
    'in_trip',
    'completed',
    'settled',
    'cancelled',
    'expired',
    'reversed'
);

CREATE TYPE escrow_status AS ENUM (
    'locked',
    'settled',
    'reversed',
    'expired'
);

CREATE TYPE ledger_account_type AS ENUM (
    'client_payment_node',
    'driver_storage_wallet',
    'driver_cashout',
    'platform_treasury'
);

CREATE TYPE ledger_transaction_type AS ENUM (
    'booking_lock',
    'trip_settlement',
    'booking_reversal',
    'manual_adjustment'
);

CREATE TYPE ledger_transaction_status AS ENUM (
    'draft',
    'posted',
    'reversed'
);

CREATE TYPE ledger_entry_side AS ENUM (
    'debit',
    'credit'
);

CREATE TYPE driver_availability_status AS ENUM (
    'offline',
    'available',
    'locked',
    'predictive_eligible'
);

CREATE TYPE allocation_mode AS ENUM (
    'predictive_window',
    'fallback_hexagon'
);

CREATE TYPE dispatch_status AS ENUM (
    'offered',
    'bid_submitted',
    'accepted',
    'rejected',
    'expired',
    'cancelled'
);

CREATE TABLE clients (
    client_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    phone_e164 TEXT NOT NULL UNIQUE,
    default_currency_code CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (default_currency_code = UPPER(default_currency_code))
);

CREATE TABLE drivers (
    driver_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    phone_e164 TEXT NOT NULL UNIQUE,
    home_h3_cell VARCHAR(16) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_accounts (
    ledger_account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_type ledger_account_type NOT NULL,
    currency_code CHAR(3) NOT NULL,
    client_id UUID NULL REFERENCES clients(client_id),
    driver_id UUID NULL REFERENCES drivers(driver_id),
    account_name TEXT NOT NULL,
    current_balance_minor BIGINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (currency_code = UPPER(currency_code)),
    CHECK (
        (
            account_type = 'client_payment_node'
            AND client_id IS NOT NULL
            AND driver_id IS NULL
        ) OR (
            account_type IN ('driver_storage_wallet', 'driver_cashout')
            AND client_id IS NULL
            AND driver_id IS NOT NULL
        ) OR (
            account_type = 'platform_treasury'
            AND client_id IS NULL
            AND driver_id IS NULL
        )
    )
);

CREATE UNIQUE INDEX uq_ledger_client_payment_node
    ON ledger_accounts (client_id, currency_code, account_type)
    WHERE account_type = 'client_payment_node';

CREATE UNIQUE INDEX uq_ledger_driver_storage_wallet
    ON ledger_accounts (driver_id, currency_code, account_type)
    WHERE account_type = 'driver_storage_wallet';

CREATE UNIQUE INDEX uq_ledger_driver_cashout
    ON ledger_accounts (driver_id, currency_code, account_type)
    WHERE account_type = 'driver_cashout';

CREATE UNIQUE INDEX uq_ledger_platform_treasury
    ON ledger_accounts (currency_code, account_type)
    WHERE account_type = 'platform_treasury';

CREATE TABLE ride_orders (
    order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(client_id),
    active_driver_id UUID NULL REFERENCES drivers(driver_id),
    status order_status NOT NULL DEFAULT 'pending_payment',
    requested_h3_cell VARCHAR(16) NOT NULL,
    destination_h3_cell VARCHAR(16) NOT NULL,
    quoted_fare_minor BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    driver_share_bps SMALLINT NOT NULL,
    kona_commission_bps SMALLINT NOT NULL,
    booking_confirmed_at TIMESTAMPTZ NULL,
    assigned_at TIMESTAMPTZ NULL,
    pickup_started_at TIMESTAMPTZ NULL,
    trip_started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    settled_at TIMESTAMPTZ NULL,
    cancelled_at TIMESTAMPTZ NULL,
    expired_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (quoted_fare_minor > 0),
    CHECK (currency_code = UPPER(currency_code)),
    CHECK (driver_share_bps > 0 AND driver_share_bps < 10000),
    CHECK (kona_commission_bps > 0 AND kona_commission_bps < 10000),
    CHECK (driver_share_bps + kona_commission_bps = 10000)
);

CREATE UNIQUE INDEX uq_driver_single_open_order
    ON ride_orders (active_driver_id)
    WHERE active_driver_id IS NOT NULL
      AND status IN ('assigned', 'en_route_pickup', 'in_trip', 'completed');

CREATE TABLE booking_escrows (
    escrow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL UNIQUE REFERENCES ride_orders(order_id),
    source_client_payment_account_id UUID NOT NULL REFERENCES ledger_accounts(ledger_account_id),
    target_driver_storage_wallet_account_id UUID NOT NULL REFERENCES ledger_accounts(ledger_account_id),
    locked_amount_minor BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    status escrow_status NOT NULL DEFAULT 'locked',
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ NULL,
    reversed_at TIMESTAMPTZ NULL,
    timeout_at TIMESTAMPTZ NOT NULL,
    reversal_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (locked_amount_minor > 0),
    CHECK (currency_code = UPPER(currency_code))
);

CREATE TABLE ledger_transactions (
    ledger_transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NULL REFERENCES ride_orders(order_id),
    escrow_id UUID NULL REFERENCES booking_escrows(escrow_id),
    transaction_type ledger_transaction_type NOT NULL,
    status ledger_transaction_status NOT NULL DEFAULT 'draft',
    currency_code CHAR(3) NOT NULL,
    external_reference TEXT NULL UNIQUE,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    posted_at TIMESTAMPTZ NULL,
    reversed_at TIMESTAMPTZ NULL,
    CHECK (currency_code = UPPER(currency_code))
);

CREATE TABLE ledger_entries (
    ledger_entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ledger_transaction_id UUID NOT NULL REFERENCES ledger_transactions(ledger_transaction_id) ON DELETE CASCADE,
    ledger_account_id UUID NOT NULL REFERENCES ledger_accounts(ledger_account_id),
    entry_side ledger_entry_side NOT NULL,
    amount_minor BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (amount_minor > 0)
);

CREATE INDEX ix_ledger_entries_transaction
    ON ledger_entries (ledger_transaction_id);

CREATE INDEX ix_ledger_entries_account
    ON ledger_entries (ledger_account_id, created_at DESC);

CREATE TABLE driver_states (
    driver_id UUID PRIMARY KEY REFERENCES drivers(driver_id),
    active_order_id UUID NULL UNIQUE REFERENCES ride_orders(order_id),
    availability_status driver_availability_status NOT NULL DEFAULT 'offline',
    active_order_status order_status NULL,
    current_h3_cell VARCHAR(16) NOT NULL,
    Time_To_Complete NUMERIC(8,2) NULL,
    Km_Remained NUMERIC(8,3) NULL,
    predictive_time_threshold_minutes NUMERIC(8,2) NOT NULL DEFAULT 8.00,
    predictive_km_threshold NUMERIC(8,3) NOT NULL DEFAULT 3.000,
    predictive_window_open BOOLEAN NOT NULL DEFAULT FALSE,
    driver_split_ledger_balance_minor BIGINT NOT NULL DEFAULT 0,
    kona_corporate_split_ledger_balance_minor BIGINT NOT NULL DEFAULT 0,
    lockout_reason TEXT NULL,
    last_tracker_update_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (Time_To_Complete IS NULL OR Time_To_Complete >= 0),
    CHECK (Km_Remained IS NULL OR Km_Remained >= 0),
    CHECK (
        (active_order_id IS NULL AND active_order_status IS NULL)
        OR (active_order_id IS NOT NULL AND active_order_status IS NOT NULL)
    )
);

CREATE INDEX ix_driver_states_allocation_window
    ON driver_states (availability_status, predictive_window_open, current_h3_cell);

CREATE TABLE dispatch_offers (
    dispatch_offer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES ride_orders(order_id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES drivers(driver_id),
    allocation_mode allocation_mode NOT NULL,
    source_h3_cell VARCHAR(16) NOT NULL,
    proximity_ring SMALLINT NOT NULL DEFAULT 0,
    offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    status dispatch_status NOT NULL DEFAULT 'offered',
    bid_amount_minor BIGINT NULL,
    bid_submitted_at TIMESTAMPTZ NULL,
    accepted_at TIMESTAMPTZ NULL,
    rejected_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (proximity_ring >= 0),
    CHECK (bid_amount_minor IS NULL OR bid_amount_minor > 0),
    UNIQUE (order_id, driver_id)
);

CREATE INDEX ix_dispatch_offers_matching
    ON dispatch_offers (order_id, allocation_mode, status, expires_at);

CREATE OR REPLACE FUNCTION set_row_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_balanced_posted_ledger_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    affected_transaction_id UUID;
    parent_status ledger_transaction_status;
    transaction_balance BIGINT;
BEGIN
    affected_transaction_id := COALESCE(NEW.ledger_transaction_id, OLD.ledger_transaction_id);

    SELECT status
    INTO parent_status
    FROM ledger_transactions
    WHERE ledger_transaction_id = affected_transaction_id;

    IF parent_status <> 'posted' THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(SUM(
        CASE entry_side
            WHEN 'credit' THEN amount_minor
            ELSE -amount_minor
        END
    ), 0)
    INTO transaction_balance
    FROM ledger_entries
    WHERE ledger_transaction_id = affected_transaction_id;

    IF transaction_balance <> 0 THEN
        RAISE EXCEPTION 'Posted ledger transaction % is not balanced', affected_transaction_id;
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION apply_ledger_entry_balance_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status ledger_transaction_status;
    signed_delta BIGINT;
BEGIN
    SELECT status
    INTO parent_status
    FROM ledger_transactions
    WHERE ledger_transaction_id = NEW.ledger_transaction_id;

    IF parent_status <> 'posted' THEN
        RETURN NEW;
    END IF;

    signed_delta := CASE NEW.entry_side
        WHEN 'debit' THEN -NEW.amount_minor
        ELSE NEW.amount_minor
    END;

    UPDATE ledger_accounts
    SET current_balance_minor = current_balance_minor + signed_delta,
        updated_at = NOW()
    WHERE ledger_account_id = NEW.ledger_account_id;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sync_driver_state_from_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    is_open_driver_order BOOLEAN;
BEGIN
    IF NEW.active_driver_id IS NULL THEN
        RETURN NEW;
    END IF;

    is_open_driver_order := NEW.status IN ('assigned', 'en_route_pickup', 'in_trip', 'completed');

    INSERT INTO driver_states (
        driver_id,
        active_order_id,
        availability_status,
        active_order_status,
        current_h3_cell,
        lockout_reason,
        predictive_window_open,
        last_tracker_update_at
    )
    VALUES (
        NEW.active_driver_id,
        CASE WHEN is_open_driver_order THEN NEW.order_id ELSE NULL END,
        CASE WHEN is_open_driver_order THEN 'locked' ELSE 'available' END,
        CASE WHEN is_open_driver_order THEN NEW.status ELSE NULL END,
        NEW.destination_h3_cell,
        CASE WHEN is_open_driver_order THEN 'Driver cannot view or receive new offers until the active order is settled or predictive thresholds open the window.' ELSE NULL END,
        FALSE,
        NOW()
    )
    ON CONFLICT (driver_id) DO UPDATE
    SET active_order_id = EXCLUDED.active_order_id,
        availability_status = EXCLUDED.availability_status,
        active_order_status = EXCLUDED.active_order_status,
        lockout_reason = EXCLUDED.lockout_reason,
        last_tracker_update_at = NOW(),
        updated_at = NOW();

    IF NEW.status = 'settled' THEN
        UPDATE driver_states
        SET active_order_id = NULL,
            active_order_status = NULL,
            availability_status = 'available',
            predictive_window_open = FALSE,
            lockout_reason = NULL,
            Time_To_Complete = NULL,
            Km_Remained = NULL,
            last_tracker_update_at = NOW(),
            updated_at = NOW()
        WHERE driver_id = NEW.active_driver_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_driver_state_split_balances()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    settled_driver_id UUID;
BEGIN
    SELECT ro.active_driver_id
    INTO settled_driver_id
    FROM ledger_transactions lt
    JOIN ride_orders ro ON ro.order_id = lt.order_id
    WHERE lt.ledger_transaction_id = NEW.ledger_transaction_id
      AND lt.transaction_type = 'trip_settlement';

    IF settled_driver_id IS NULL THEN
        RETURN NEW;
    END IF;

    UPDATE driver_states ds
    SET driver_split_ledger_balance_minor = COALESCE(driver_balances.driver_balance_minor, 0),
        kona_corporate_split_ledger_balance_minor = COALESCE(kona_balances.kona_balance_minor, 0),
        updated_at = NOW()
    FROM (
        SELECT la.driver_id, SUM(la.current_balance_minor) AS driver_balance_minor
        FROM ledger_accounts la
        WHERE la.account_type = 'driver_cashout'
        GROUP BY la.driver_id
    ) AS driver_balances,
    (
        SELECT ro.active_driver_id AS driver_id, COALESCE(SUM(le.amount_minor), 0) AS kona_balance_minor
        FROM ledger_entries le
        JOIN ledger_transactions lt ON lt.ledger_transaction_id = le.ledger_transaction_id
        JOIN ledger_accounts la ON la.ledger_account_id = le.ledger_account_id
        JOIN ride_orders ro ON ro.order_id = lt.order_id
        WHERE lt.transaction_type = 'trip_settlement'
          AND lt.status = 'posted'
          AND la.account_type = 'platform_treasury'
          AND le.entry_side = 'credit'
        GROUP BY ro.active_driver_id
    ) AS kona_balances
    WHERE ds.driver_id = settled_driver_id
      AND ds.driver_id = driver_balances.driver_id
      AND ds.driver_id = kona_balances.driver_id;

    UPDATE driver_states ds
    SET driver_split_ledger_balance_minor = COALESCE(driver_balances.driver_balance_minor, 0),
        kona_corporate_split_ledger_balance_minor = 0,
        updated_at = NOW()
    FROM (
        SELECT la.driver_id, SUM(la.current_balance_minor) AS driver_balance_minor
        FROM ledger_accounts la
        WHERE la.account_type = 'driver_cashout'
        GROUP BY la.driver_id
    ) AS driver_balances
    WHERE ds.driver_id = settled_driver_id
      AND ds.driver_id = driver_balances.driver_id
      AND NOT EXISTS (
          SELECT 1
          FROM ledger_entries le
          JOIN ledger_transactions lt ON lt.ledger_transaction_id = le.ledger_transaction_id
          JOIN ledger_accounts la ON la.ledger_account_id = le.ledger_account_id
          JOIN ride_orders ro ON ro.order_id = lt.order_id
          WHERE lt.transaction_type = 'trip_settlement'
            AND lt.status = 'posted'
            AND la.account_type = 'platform_treasury'
            AND le.entry_side = 'credit'
            AND ro.active_driver_id = ds.driver_id
      );

    RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW driver_state_object AS
SELECT
    ds.driver_id,
    JSONB_BUILD_OBJECT(
        'Driver_Id', ds.driver_id,
        'Active_Order_Id', ds.active_order_id,
        'Availability_Status', ds.availability_status,
        'Active_Order_Status', ds.active_order_status,
        'Current_H3_Cell', ds.current_h3_cell,
        'Time_To_Complete', ds.Time_To_Complete,
        'Km_Remained', ds.Km_Remained,
        'Predictive_Time_Threshold_Minutes', ds.predictive_time_threshold_minutes,
        'Predictive_Km_Threshold', ds.predictive_km_threshold,
        'Predictive_Window_Open', ds.predictive_window_open,
        'Driver_Split_Ledger_Balance_Minor', ds.driver_split_ledger_balance_minor,
        'KONA_Corporate_Split_Ledger_Balance_Minor', ds.kona_corporate_split_ledger_balance_minor,
        'Lockout_Reason', ds.lockout_reason,
        'Last_Tracker_Update_At', ds.last_tracker_update_at
    ) AS driver_state
FROM driver_states ds;

CREATE OR REPLACE VIEW eligible_order_allocation_drivers AS
SELECT
    ds.driver_id,
    ds.current_h3_cell,
    ds.availability_status,
    ds.predictive_window_open,
    ds.Time_To_Complete,
    ds.Km_Remained,
    CASE
        WHEN ds.availability_status = 'available' THEN 'fallback_hexagon'
        WHEN ds.availability_status = 'predictive_eligible'
             AND ds.predictive_window_open = TRUE
             AND ds.Time_To_Complete <= ds.predictive_time_threshold_minutes
             AND ds.Km_Remained <= ds.predictive_km_threshold THEN 'predictive_window'
        ELSE NULL
    END AS allocation_mode
FROM driver_states ds
WHERE ds.availability_status IN ('available', 'predictive_eligible');

CREATE TRIGGER trg_clients_updated_at
BEFORE UPDATE ON clients
FOR EACH ROW
EXECUTE FUNCTION set_row_updated_at();

CREATE TRIGGER trg_drivers_updated_at
BEFORE UPDATE ON drivers
FOR EACH ROW
EXECUTE FUNCTION set_row_updated_at();

CREATE TRIGGER trg_ledger_accounts_updated_at
BEFORE UPDATE ON ledger_accounts
FOR EACH ROW
EXECUTE FUNCTION set_row_updated_at();

CREATE TRIGGER trg_ride_orders_updated_at
BEFORE UPDATE ON ride_orders
FOR EACH ROW
EXECUTE FUNCTION set_row_updated_at();

CREATE TRIGGER trg_driver_states_updated_at
BEFORE UPDATE ON driver_states
FOR EACH ROW
EXECUTE FUNCTION set_row_updated_at();

CREATE CONSTRAINT TRIGGER trg_ledger_transaction_balanced_on_entries
AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION ensure_balanced_posted_ledger_transaction();

CREATE CONSTRAINT TRIGGER trg_ledger_transaction_balanced_on_transactions
AFTER UPDATE OF status ON ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.status = 'posted')
EXECUTE FUNCTION ensure_balanced_posted_ledger_transaction();

CREATE TRIGGER trg_apply_ledger_entry_balance_change
AFTER INSERT ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION apply_ledger_entry_balance_change();

CREATE TRIGGER trg_sync_driver_state_from_order
AFTER INSERT OR UPDATE OF active_driver_id, status ON ride_orders
FOR EACH ROW
WHEN (NEW.active_driver_id IS NOT NULL)
EXECUTE FUNCTION sync_driver_state_from_order();

CREATE TRIGGER trg_refresh_driver_state_split_balances
AFTER INSERT ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION refresh_driver_state_split_balances();