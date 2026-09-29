DO $$
DECLARE
  markers jsonb;
  work_item record;
  saved_marker text;
  marker_value jsonb;
  item_value jsonb;
  marker_time timestamptz;
  item_time timestamptz;
  marker_id text;
  item_id text;
BEGIN
  BEGIN
    SELECT value::jsonb INTO markers
    FROM router_state
    WHERE key = 'last_agent_timestamp';
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN;
  END;
  IF markers IS NULL OR jsonb_typeof(markers) <> 'object' THEN
    RETURN;
  END IF;

  FOR work_item IN
    SELECT id, queue_jid, message_cursor
    FROM live_admission_work_items
    WHERE consumed_at IS NULL
  LOOP
    saved_marker := markers ->> work_item.queue_jid;
    IF saved_marker IS NULL OR saved_marker = '' THEN
      CONTINUE;
    END IF;
    BEGIN
      item_value := work_item.message_cursor::jsonb;
      item_time := (item_value ->> 'timestamp')::timestamptz;
      item_id := item_value ->> 'id';
      IF left(saved_marker, 1) = '{' THEN
        marker_value := saved_marker::jsonb;
        marker_time := (marker_value ->> 'timestamp')::timestamptz;
        marker_id := marker_value ->> 'id';
      ELSE
        marker_time := saved_marker::timestamptz;
        marker_id := U&'\FFFF';
      END IF;
      IF item_time < marker_time OR
        (item_time = marker_time AND item_id <= marker_id) THEN
        UPDATE live_admission_work_items
        SET consumed_at = clock_timestamp(), consumed_by = 'history'
        WHERE id = work_item.id AND consumed_at IS NULL;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format THEN
      CONTINUE;
    END;
  END LOOP;
END $$;
