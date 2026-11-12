-- Migration: Official KNEC CBC 8-Band Performance Grading Framework
INSERT INTO grading_systems (name, code, is_active)
VALUES ('CBC Junior School 8-Band Standard', 'CBC_8_BAND', true)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
    v_sys_id INT;
BEGIN
    SELECT id INTO v_sys_id FROM grading_systems WHERE code = 'CBC_8_BAND' LIMIT 1;
    IF v_sys_id IS NOT NULL THEN
        DELETE FROM grading_bands WHERE grading_system_id = v_sys_id;
        INSERT INTO grading_bands (grading_system_id, label, min_mark, max_mark, points, descriptor, remark)
        VALUES
            (v_sys_id, 'EE1', 90.00, 100.00, 8.0, 'Exceeding Expectations (Advanced)',    'Exceptional mastery of core competencies'),
            (v_sys_id, 'EE2', 80.00,  89.99, 7.0, 'Exceeding Expectations (Proficient)',  'Very good demonstration of competencies'),
            (v_sys_id, 'ME1', 70.00,  79.99, 6.0, 'Meeting Expectations (High)',          'Proficient performance across learning areas'),
            (v_sys_id, 'ME2', 50.00,  69.99, 5.0, 'Meeting Expectations (Standard)',      'Satisfactory competence achieved'),
            (v_sys_id, 'AE1', 40.00,  49.99, 4.0, 'Approaching Expectations (Upper)',     'Shows potential; minor remediation needed'),
            (v_sys_id, 'AE2', 30.00,  39.99, 3.0, 'Approaching Expectations (Lower)',     'Needs targeted reinforcement in key areas'),
            (v_sys_id, 'BE1', 20.00,  29.99, 2.0, 'Below Expectations (Upper)',           'Substantial academic intervention required'),
            (v_sys_id, 'BE2',  0.00,  19.99, 1.0, 'Below Expectations (Foundation)',      'Urgent personalized remedial support required');
    END IF;
END $$;
