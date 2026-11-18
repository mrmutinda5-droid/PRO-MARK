-- Optional example grading systems. These are examples only and can be replaced/configured per school.
-- Run after creating a school, replacing SCHOOL_ID below with that school's UUID.

-- Junior/CBC example:
-- INSERT INTO grading_systems(school_id,name,code,description) VALUES
-- ('SCHOOL_ID','Junior Performance Levels','JUNIOR_CBC','Configurable performance levels');
-- INSERT INTO grading_bands(grading_system_id,label,min_mark,max_mark,points,descriptor,remark)
-- SELECT id,'EE',70,100,4,'Exceeds Expectations','Excellent'
-- FROM grading_systems WHERE school_id='SCHOOL_ID' AND code='JUNIOR_CBC';
-- ... add ME, AE, BE as required.

-- Old secondary example:
-- A 12, A- 11, B+ 10, B 9, B- 8, C+ 7, C 6, C- 5, D+ 4, D 3, D- 2, E 1.
-- Exact mark ranges should be configured by the school according to the grading rules it adopts.
