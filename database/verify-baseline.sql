-- Rollback-only verification. No fixtures survive. Run as postgres in SQL Editor.
begin;
-- 1. Create disposable users inside the rollback transaction

insert into auth.users(id,email) values ('10000000-0000-4000-8000-000000000001','planner-owner@example.invalid'),('10000000-0000-4000-8000-000000000002','planner-other@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);


-- 2. Owner can create project and unplanned standalone task

insert into public.projects(id,title) values ('20000000-0000-4000-8000-000000000001','Test project');
insert into public.tasks(id,title) values ('20000000-0000-4000-8000-000000000002','Standalone unplanned task');
insert into public.tasks(id,project_id,title) values ('20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','Project task');
insert into public.task_completion_conditions(id,task_id,description) values ('20000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000003','Deliver result');


-- 3. Task can exist with no project and no time blocks
do $test$ begin if not (exists(select 1 from public.tasks where id='20000000-0000-4000-8000-000000000002' and project_id is null) and not exists(select 1 from public.time_block_tasks where task_id='20000000-0000-4000-8000-000000000002')) then raise exception 'Task can exist with no project and no time blocks'; end if; end $test$;

-- 4. Unmet condition blocks manual task completion
do $test$ begin begin update public.tasks set completed_at=now() where id='20000000-0000-4000-8000-000000000003'; raise exception 'Expected SQLSTATE 23514' using errcode = 'P0001'; exception when sqlstate '23514' then null; end; end $test$;

-- 5. Incomplete task blocks manual project completion
do $test$ begin begin update public.projects set completed_at=now() where id='20000000-0000-4000-8000-000000000001'; raise exception 'Expected SQLSTATE 23514' using errcode = 'P0001'; exception when sqlstate '23514' then null; end; end $test$;

-- 6. Check the final condition
update public.task_completion_conditions set is_met=true where id='20000000-0000-4000-8000-000000000004';

-- 7. Meeting every condition does not auto-complete the task
do $test$ begin if not (exists(select 1 from public.tasks where id='20000000-0000-4000-8000-000000000003' and completed_at is null)) then raise exception 'Meeting every condition does not auto-complete the task'; end if; end $test$;

-- 8. Explicitly complete the task
update public.tasks set completed_at=now() where id='20000000-0000-4000-8000-000000000003';

-- 9. Completing every task does not auto-complete the project
do $test$ begin if not (exists(select 1 from public.projects where id='20000000-0000-4000-8000-000000000001' and completed_at is null)) then raise exception 'Completing every task does not auto-complete the project'; end if; end $test$;

-- 10. Explicitly complete the project
update public.projects set completed_at=now() where id='20000000-0000-4000-8000-000000000001';

-- 11. Manual project completion succeeds after its tasks
do $test$ begin if not (exists(select 1 from public.projects where id='20000000-0000-4000-8000-000000000001' and completed_at is not null)) then raise exception 'Manual project completion succeeds after its tasks'; end if; end $test$;

-- 12. Uncheck a condition after completion
update public.task_completion_conditions set is_met=false where id='20000000-0000-4000-8000-000000000004';

-- 13. Unchecking a condition reopens both task and project
do $test$ begin if not (exists(select 1 from public.tasks where id='20000000-0000-4000-8000-000000000003' and completed_at is null) and exists(select 1 from public.projects where id='20000000-0000-4000-8000-000000000001' and completed_at is null)) then raise exception 'Unchecking a condition reopens both task and project'; end if; end $test$;

-- 14. Recheck and explicitly recomplete both levels

update public.task_completion_conditions set is_met=true where id='20000000-0000-4000-8000-000000000004';
update public.tasks set completed_at=now() where id='20000000-0000-4000-8000-000000000003';
update public.projects set completed_at=now() where id='20000000-0000-4000-8000-000000000001';


-- 15. Edit descriptions without changing completion premises
update public.tasks set title='Renamed completed task' where id='20000000-0000-4000-8000-000000000003'; update public.projects set description='Edited note' where id='20000000-0000-4000-8000-000000000001';

-- 16. Text edits retain completed state
do $test$ begin if not (exists(select 1 from public.tasks where id='20000000-0000-4000-8000-000000000003' and completed_at is not null) and exists(select 1 from public.projects where id='20000000-0000-4000-8000-000000000001' and completed_at is not null)) then raise exception 'Text edits retain completed state'; end if; end $test$;

-- 17. Add a new unmet completion condition
insert into public.task_completion_conditions(id,task_id,description) values ('20000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000003','New acceptance condition');

-- 18. New unmet condition reopens both levels
do $test$ begin if not (exists(select 1 from public.tasks where id='20000000-0000-4000-8000-000000000003' and completed_at is null) and exists(select 1 from public.projects where id='20000000-0000-4000-8000-000000000001' and completed_at is null)) then raise exception 'New unmet condition reopens both levels'; end if; end $test$;

-- 19. Recomplete before adding a new task
update public.task_completion_conditions set is_met=true where id='20000000-0000-4000-8000-000000000005'; update public.tasks set completed_at=now() where id='20000000-0000-4000-8000-000000000003'; update public.projects set completed_at=now() where id='20000000-0000-4000-8000-000000000001';

-- 20. Add an incomplete task to a completed project
insert into public.tasks(id,project_id,title) values ('20000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000001','New project task');

-- 21. Adding an incomplete task reopens the project
do $test$ begin if not (exists(select 1 from public.projects where id='20000000-0000-4000-8000-000000000001' and completed_at is null)) then raise exception 'Adding an incomplete task reopens the project'; end if; end $test$;

-- 22. Complete a task with no conditions manually
update public.tasks set completed_at=now() where id='20000000-0000-4000-8000-000000000006';

-- 23. Task without conditions can be completed manually
do $test$ begin if not (exists(select 1 from public.tasks where id='20000000-0000-4000-8000-000000000006' and completed_at is not null)) then raise exception 'Task without conditions can be completed manually'; end if; end $test$;

-- 24. Create thoughts and many-to-many provenance

insert into public.thoughts(id,content) values ('20000000-0000-4000-8000-000000000010','First source thought'),('20000000-0000-4000-8000-000000000011','Second source thought');
insert into public.thought_task_links(thought_id,task_id) values ('20000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000002'),('20000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000003'),('20000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000003');
insert into public.thought_project_links(thought_id,project_id) values ('20000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000001');


-- 25. Conversion retains thoughts and all many-to-many source links
do $test$ begin if not ((select count(*) from public.thoughts)=2 and (select count(*) from public.thought_task_links)=3 and (select count(*) from public.thought_project_links)=2) then raise exception 'Conversion retains thoughts and all many-to-many source links'; end if; end $test$;

-- 26. Duplicate thought-to-task relation is rejected
do $test$ begin begin insert into public.thought_task_links(thought_id,task_id) values ('20000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000003'); raise exception 'Expected SQLSTATE 23505' using errcode = 'P0001'; exception when sqlstate '23505' then null; end; end $test$;

-- 27. Create a fixed weekday habit
insert into public.habits(id,title,starts_on,iso_weekdays) values ('20000000-0000-4000-8000-000000000020','Read on Monday Wednesday Friday','2026-10-01',array[1,3,5]::smallint[]);

-- 28. Create Monday and Wednesday occurrences
insert into public.habit_occurrences(id,habit_id,scheduled_on) values ('20000000-0000-4000-8000-000000000021','20000000-0000-4000-8000-000000000020','2026-10-19'),('20000000-0000-4000-8000-000000000022','20000000-0000-4000-8000-000000000020','2026-10-21');

-- 29. Occurrence inherits planned day and timezone
do $test$ begin if not (exists(select 1 from public.habit_occurrences where id='20000000-0000-4000-8000-000000000021' and planned_on='2026-10-19' and timezone='Asia/Kuala_Lumpur')) then raise exception 'Occurrence inherits planned day and timezone'; end if; end $test$;

-- 30. A Tuesday is not an original Monday Wednesday Friday occurrence
do $test$ begin begin insert into public.habit_occurrences(habit_id,scheduled_on) values ('20000000-0000-4000-8000-000000000020','2026-10-20'); raise exception 'Expected SQLSTATE 23514' using errcode = 'P0001'; exception when sqlstate '23514' then null; end; end $test$;

-- 31. Reschedule only the Monday occurrence to Tuesday
update public.habit_occurrences set planned_on='2026-10-20' where id='20000000-0000-4000-8000-000000000021';

-- 32. Rescheduling preserves the original date and fixed weekday rule
do $test$ begin if not (exists(select 1 from public.habit_occurrences where id='20000000-0000-4000-8000-000000000021' and scheduled_on='2026-10-19' and planned_on='2026-10-20') and exists(select 1 from public.habits where id='20000000-0000-4000-8000-000000000020' and iso_weekdays=array[1,3,5]::smallint[]) and exists(select 1 from public.habit_occurrences where id='20000000-0000-4000-8000-000000000022' and planned_on='2026-10-21')) then raise exception 'Rescheduling preserves the original date and fixed weekday rule'; end if; end $test$;

-- 33. Original occurrence date cannot be rewritten
do $test$ begin begin update public.habit_occurrences set scheduled_on='2026-10-20' where id='20000000-0000-4000-8000-000000000021'; raise exception 'Expected SQLSTATE 23514' using errcode = 'P0001'; exception when sqlstate '23514' then null; end; end $test$;

-- 34. Record late execution with its actual date
insert into public.habit_executions(id,habit_id,occurrence_id,performed_on) values ('20000000-0000-4000-8000-000000000023','20000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000021','2026-10-22');

-- 35. Late execution preserves planned and actual dates
do $test$ begin if not (exists(select 1 from public.habit_occurrence_status where id='20000000-0000-4000-8000-000000000021' and scheduled_on='2026-10-19' and planned_on='2026-10-20' and performed_on='2026-10-22' and is_completed and state='completed')) then raise exception 'Late execution preserves planned and actual dates'; end if; end $test$;

-- 36. One occurrence cannot be completed twice
do $test$ begin begin insert into public.habit_executions(habit_id,occurrence_id,performed_on) values ('20000000-0000-4000-8000-000000000020','20000000-0000-4000-8000-000000000021','2026-10-23'); raise exception 'Expected SQLSTATE 23505' using errcode = 'P0001'; exception when sqlstate '23505' then null; end; end $test$;

-- 37. One execution cannot be moved to cover another occurrence
do $test$ begin begin update public.habit_executions set occurrence_id='20000000-0000-4000-8000-000000000022' where id='20000000-0000-4000-8000-000000000023'; raise exception 'Expected SQLSTATE 23514' using errcode = 'P0001'; exception when sqlstate '23514' then null; end; end $test$;

-- 38. Habit completion never creates a task
do $test$ begin if not ((select count(*) from public.tasks)=3) then raise exception 'Habit completion never creates a task'; end if; end $test$;

-- 39. Missed occurrence is retained without automatic rollover
do $test$ begin if not (exists(select 1 from public.habit_occurrences where id='20000000-0000-4000-8000-000000000022' and scheduled_on='2026-10-21' and planned_on='2026-10-21') and not exists(select 1 from public.habit_executions where occurrence_id='20000000-0000-4000-8000-000000000022')) then raise exception 'Missed occurrence is retained without automatic rollover'; end if; end $test$;

-- 40. Empty habit weekday set is rejected
do $test$ begin begin insert into public.habits(title,iso_weekdays) values ('Invalid habit',array[]::smallint[]); raise exception 'Expected SQLSTATE 23514' using errcode = 'P0001'; exception when sqlstate '23514' then null; end; end $test$;

-- 41. Invalid timezone is rejected
do $test$ begin begin insert into public.habits(title,iso_weekdays,timezone) values ('Invalid timezone',array[1]::smallint[],'Invalid/Nowhere'); raise exception 'Expected SQLSTATE 23514' using errcode = 'P0001'; exception when sqlstate '23514' then null; end; end $test$;

-- 42. Create two shared blocks and one independent activity

insert into public.time_blocks(id,title,starts_at,ends_at) values
 ('20000000-0000-4000-8000-000000000030','First session','2026-10-22T09:00:00+08:00','2026-10-22T09:30:00+08:00'),
 ('20000000-0000-4000-8000-000000000031','Second session','2026-10-23T09:00:00+08:00','2026-10-23T10:00:00+08:00'),
 ('20000000-0000-4000-8000-000000000032','Independent rest','2026-10-22T12:00:00+08:00','2026-10-22T12:30:00+08:00');
insert into public.time_block_tasks(time_block_id,task_id) values ('20000000-0000-4000-8000-000000000030','20000000-0000-4000-8000-000000000002'),('20000000-0000-4000-8000-000000000030','20000000-0000-4000-8000-000000000003'),('20000000-0000-4000-8000-000000000031','20000000-0000-4000-8000-000000000002');
insert into public.time_block_habit_occurrences(time_block_id,occurrence_id) values ('20000000-0000-4000-8000-000000000030','20000000-0000-4000-8000-000000000021'),('20000000-0000-4000-8000-000000000030','20000000-0000-4000-8000-000000000022');


-- 43. Task can span multiple blocks and one block can cover multiple tasks and habits
do $test$ begin if not ((select count(*) from public.time_block_tasks where task_id='20000000-0000-4000-8000-000000000002')=2 and (select count(*) from public.time_block_tasks where time_block_id='20000000-0000-4000-8000-000000000030')=2 and (select count(*) from public.time_block_habit_occurrences where time_block_id='20000000-0000-4000-8000-000000000030')=2) then raise exception 'Task can span multiple blocks and one block can cover multiple tasks and habits'; end if; end $test$;

-- 44. Standalone activity has no task or habit requirement
do $test$ begin if not (exists(select 1 from public.time_blocks where id='20000000-0000-4000-8000-000000000032') and not exists(select 1 from public.time_block_tasks where time_block_id='20000000-0000-4000-8000-000000000032') and not exists(select 1 from public.time_block_habit_occurrences where time_block_id='20000000-0000-4000-8000-000000000032')) then raise exception 'Standalone activity has no task or habit requirement'; end if; end $test$;

-- 45. Time blocks do not have completion fields
do $test$ begin if not (not exists(select 1 from information_schema.columns where table_schema='public' and table_name='time_blocks' and column_name in ('completed_at','is_completed','status'))) then raise exception 'Time blocks do not have completion fields'; end if; end $test$;

-- 46. Non-positive planned duration is rejected
do $test$ begin begin insert into public.time_blocks(starts_at,ends_at) values ('2026-10-22T10:00:00Z','2026-10-22T09:00:00Z'); raise exception 'Expected SQLSTATE 23514' using errcode = 'P0001'; exception when sqlstate '23514' then null; end; end $test$;

-- 47. Owner can read their projects
do $test$ begin if not ((select count(*) from public.projects)>0) then raise exception 'Owner can read their projects'; end if; end $test$;

-- 48. Owner can read their tasks
do $test$ begin if not ((select count(*) from public.tasks)>0) then raise exception 'Owner can read their tasks'; end if; end $test$;

-- 49. Owner can read their task_completion_conditions
do $test$ begin if not ((select count(*) from public.task_completion_conditions)>0) then raise exception 'Owner can read their task_completion_conditions'; end if; end $test$;

-- 50. Owner can read their thoughts
do $test$ begin if not ((select count(*) from public.thoughts)>0) then raise exception 'Owner can read their thoughts'; end if; end $test$;

-- 51. Owner can read their thought_task_links
do $test$ begin if not ((select count(*) from public.thought_task_links)>0) then raise exception 'Owner can read their thought_task_links'; end if; end $test$;

-- 52. Owner can read their thought_project_links
do $test$ begin if not ((select count(*) from public.thought_project_links)>0) then raise exception 'Owner can read their thought_project_links'; end if; end $test$;

-- 53. Owner can read their habits
do $test$ begin if not ((select count(*) from public.habits)>0) then raise exception 'Owner can read their habits'; end if; end $test$;

-- 54. Owner can read their habit_occurrences
do $test$ begin if not ((select count(*) from public.habit_occurrences)>0) then raise exception 'Owner can read their habit_occurrences'; end if; end $test$;

-- 55. Owner can read their habit_executions
do $test$ begin if not ((select count(*) from public.habit_executions)>0) then raise exception 'Owner can read their habit_executions'; end if; end $test$;

-- 56. Owner can read their time_blocks
do $test$ begin if not ((select count(*) from public.time_blocks)>0) then raise exception 'Owner can read their time_blocks'; end if; end $test$;

-- 57. Owner can read their time_block_tasks
do $test$ begin if not ((select count(*) from public.time_block_tasks)>0) then raise exception 'Owner can read their time_block_tasks'; end if; end $test$;

-- 58. Owner can read their time_block_habit_occurrences
do $test$ begin if not ((select count(*) from public.time_block_habit_occurrences)>0) then raise exception 'Owner can read their time_block_habit_occurrences'; end if; end $test$;

-- 59. Switch to another authenticated user
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true); select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);

-- 60. Other user cannot read projects
do $test$ begin if not ((select count(*) from public.projects)=0) then raise exception 'Other user cannot read projects'; end if; end $test$;

-- 61. Other user cannot update projects
do $test$ declare affected integer; begin update public.projects set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 62. Other user cannot delete projects
do $test$ declare affected integer; begin delete from public.projects; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 63. Other user cannot read tasks
do $test$ begin if not ((select count(*) from public.tasks)=0) then raise exception 'Other user cannot read tasks'; end if; end $test$;

-- 64. Other user cannot update tasks
do $test$ declare affected integer; begin update public.tasks set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 65. Other user cannot delete tasks
do $test$ declare affected integer; begin delete from public.tasks; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 66. Other user cannot read task_completion_conditions
do $test$ begin if not ((select count(*) from public.task_completion_conditions)=0) then raise exception 'Other user cannot read task_completion_conditions'; end if; end $test$;

-- 67. Other user cannot update task_completion_conditions
do $test$ declare affected integer; begin update public.task_completion_conditions set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 68. Other user cannot delete task_completion_conditions
do $test$ declare affected integer; begin delete from public.task_completion_conditions; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 69. Other user cannot read thoughts
do $test$ begin if not ((select count(*) from public.thoughts)=0) then raise exception 'Other user cannot read thoughts'; end if; end $test$;

-- 70. Other user cannot update thoughts
do $test$ declare affected integer; begin update public.thoughts set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 71. Other user cannot delete thoughts
do $test$ declare affected integer; begin delete from public.thoughts; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 72. Other user cannot read thought_task_links
do $test$ begin if not ((select count(*) from public.thought_task_links)=0) then raise exception 'Other user cannot read thought_task_links'; end if; end $test$;

-- 73. Other user cannot update thought_task_links
do $test$ declare affected integer; begin update public.thought_task_links set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 74. Other user cannot delete thought_task_links
do $test$ declare affected integer; begin delete from public.thought_task_links; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 75. Other user cannot read thought_project_links
do $test$ begin if not ((select count(*) from public.thought_project_links)=0) then raise exception 'Other user cannot read thought_project_links'; end if; end $test$;

-- 76. Other user cannot update thought_project_links
do $test$ declare affected integer; begin update public.thought_project_links set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 77. Other user cannot delete thought_project_links
do $test$ declare affected integer; begin delete from public.thought_project_links; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 78. Other user cannot read habits
do $test$ begin if not ((select count(*) from public.habits)=0) then raise exception 'Other user cannot read habits'; end if; end $test$;

-- 79. Other user cannot update habits
do $test$ declare affected integer; begin update public.habits set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 80. Other user cannot delete habits
do $test$ declare affected integer; begin delete from public.habits; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 81. Other user cannot read habit_occurrences
do $test$ begin if not ((select count(*) from public.habit_occurrences)=0) then raise exception 'Other user cannot read habit_occurrences'; end if; end $test$;

-- 82. Other user cannot update habit_occurrences
do $test$ declare affected integer; begin update public.habit_occurrences set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 83. Other user cannot delete habit_occurrences
do $test$ declare affected integer; begin delete from public.habit_occurrences; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 84. Other user cannot read habit_executions
do $test$ begin if not ((select count(*) from public.habit_executions)=0) then raise exception 'Other user cannot read habit_executions'; end if; end $test$;

-- 85. Other user cannot update habit_executions
do $test$ declare affected integer; begin update public.habit_executions set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 86. Other user cannot delete habit_executions
do $test$ declare affected integer; begin delete from public.habit_executions; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 87. Other user cannot read time_blocks
do $test$ begin if not ((select count(*) from public.time_blocks)=0) then raise exception 'Other user cannot read time_blocks'; end if; end $test$;

-- 88. Other user cannot update time_blocks
do $test$ declare affected integer; begin update public.time_blocks set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 89. Other user cannot delete time_blocks
do $test$ declare affected integer; begin delete from public.time_blocks; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 90. Other user cannot read time_block_tasks
do $test$ begin if not ((select count(*) from public.time_block_tasks)=0) then raise exception 'Other user cannot read time_block_tasks'; end if; end $test$;

-- 91. Other user cannot update time_block_tasks
do $test$ declare affected integer; begin update public.time_block_tasks set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 92. Other user cannot delete time_block_tasks
do $test$ declare affected integer; begin delete from public.time_block_tasks; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 93. Other user cannot read time_block_habit_occurrences
do $test$ begin if not ((select count(*) from public.time_block_habit_occurrences)=0) then raise exception 'Other user cannot read time_block_habit_occurrences'; end if; end $test$;

-- 94. Other user cannot update time_block_habit_occurrences
do $test$ declare affected integer; begin update public.time_block_habit_occurrences set owner_id=owner_id; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner update succeeded'; end if; end $test$;

-- 95. Other user cannot delete time_block_habit_occurrences
do $test$ declare affected integer; begin delete from public.time_block_habit_occurrences; get diagnostics affected = row_count; if affected <> 0 then raise exception 'Cross-owner delete succeeded'; end if; end $test$;

-- 96. Security-invoker view does not leak another owner records
do $test$ begin if not ((select count(*) from public.habit_occurrence_status)=0) then raise exception 'Security-invoker view does not leak another owner records'; end if; end $test$;

-- 97. Other user cannot insert rows owned by the first user
do $test$ begin begin insert into public.tasks(owner_id,title) values ('10000000-0000-4000-8000-000000000001','Spoofed owner'); raise exception 'Expected SQLSTATE 42501' using errcode = 'P0001'; exception when sqlstate '42501' then null; end; end $test$;

-- 98. Cross-owner project association fails at the foreign key
do $test$ begin begin insert into public.tasks(project_id,title) values ('20000000-0000-4000-8000-000000000001','Cross-owner relation'); raise exception 'Expected SQLSTATE 23503' using errcode = 'P0001'; exception when sqlstate '23503' then null; end; end $test$;

-- 99. Other user can create their own standalone block
insert into public.time_blocks(id,starts_at,ends_at) values ('20000000-0000-4000-8000-000000000040','2026-10-22T10:00:00Z','2026-10-22T11:00:00Z');

-- 100. Cross-owner time-block-to-task association is rejected
do $test$ begin begin insert into public.time_block_tasks(time_block_id,task_id) values ('20000000-0000-4000-8000-000000000040','20000000-0000-4000-8000-000000000002'); raise exception 'Expected SQLSTATE 23503' using errcode = 'P0001'; exception when sqlstate '23503' then null; end; end $test$;

-- 101. Return to database owner for catalog checks
reset role;

-- 102. projects has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.projects'::regclass)) then raise exception 'projects has row-level security enabled'; end if; end $test$;

-- 103. Anonymous clients have no access to projects
do $test$ begin if not (not has_table_privilege('anon','public.projects','SELECT') and not has_table_privilege('anon','public.projects','INSERT') and not has_table_privilege('anon','public.projects','UPDATE') and not has_table_privilege('anon','public.projects','DELETE')) then raise exception 'Anonymous clients have no access to projects'; end if; end $test$;

-- 104. tasks has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.tasks'::regclass)) then raise exception 'tasks has row-level security enabled'; end if; end $test$;

-- 105. Anonymous clients have no access to tasks
do $test$ begin if not (not has_table_privilege('anon','public.tasks','SELECT') and not has_table_privilege('anon','public.tasks','INSERT') and not has_table_privilege('anon','public.tasks','UPDATE') and not has_table_privilege('anon','public.tasks','DELETE')) then raise exception 'Anonymous clients have no access to tasks'; end if; end $test$;

-- 106. task_completion_conditions has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.task_completion_conditions'::regclass)) then raise exception 'task_completion_conditions has row-level security enabled'; end if; end $test$;

-- 107. Anonymous clients have no access to task_completion_conditions
do $test$ begin if not (not has_table_privilege('anon','public.task_completion_conditions','SELECT') and not has_table_privilege('anon','public.task_completion_conditions','INSERT') and not has_table_privilege('anon','public.task_completion_conditions','UPDATE') and not has_table_privilege('anon','public.task_completion_conditions','DELETE')) then raise exception 'Anonymous clients have no access to task_completion_conditions'; end if; end $test$;

-- 108. thoughts has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.thoughts'::regclass)) then raise exception 'thoughts has row-level security enabled'; end if; end $test$;

-- 109. Anonymous clients have no access to thoughts
do $test$ begin if not (not has_table_privilege('anon','public.thoughts','SELECT') and not has_table_privilege('anon','public.thoughts','INSERT') and not has_table_privilege('anon','public.thoughts','UPDATE') and not has_table_privilege('anon','public.thoughts','DELETE')) then raise exception 'Anonymous clients have no access to thoughts'; end if; end $test$;

-- 110. thought_task_links has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.thought_task_links'::regclass)) then raise exception 'thought_task_links has row-level security enabled'; end if; end $test$;

-- 111. Anonymous clients have no access to thought_task_links
do $test$ begin if not (not has_table_privilege('anon','public.thought_task_links','SELECT') and not has_table_privilege('anon','public.thought_task_links','INSERT') and not has_table_privilege('anon','public.thought_task_links','UPDATE') and not has_table_privilege('anon','public.thought_task_links','DELETE')) then raise exception 'Anonymous clients have no access to thought_task_links'; end if; end $test$;

-- 112. thought_project_links has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.thought_project_links'::regclass)) then raise exception 'thought_project_links has row-level security enabled'; end if; end $test$;

-- 113. Anonymous clients have no access to thought_project_links
do $test$ begin if not (not has_table_privilege('anon','public.thought_project_links','SELECT') and not has_table_privilege('anon','public.thought_project_links','INSERT') and not has_table_privilege('anon','public.thought_project_links','UPDATE') and not has_table_privilege('anon','public.thought_project_links','DELETE')) then raise exception 'Anonymous clients have no access to thought_project_links'; end if; end $test$;

-- 114. habits has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.habits'::regclass)) then raise exception 'habits has row-level security enabled'; end if; end $test$;

-- 115. Anonymous clients have no access to habits
do $test$ begin if not (not has_table_privilege('anon','public.habits','SELECT') and not has_table_privilege('anon','public.habits','INSERT') and not has_table_privilege('anon','public.habits','UPDATE') and not has_table_privilege('anon','public.habits','DELETE')) then raise exception 'Anonymous clients have no access to habits'; end if; end $test$;

-- 116. habit_occurrences has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.habit_occurrences'::regclass)) then raise exception 'habit_occurrences has row-level security enabled'; end if; end $test$;

-- 117. Anonymous clients have no access to habit_occurrences
do $test$ begin if not (not has_table_privilege('anon','public.habit_occurrences','SELECT') and not has_table_privilege('anon','public.habit_occurrences','INSERT') and not has_table_privilege('anon','public.habit_occurrences','UPDATE') and not has_table_privilege('anon','public.habit_occurrences','DELETE')) then raise exception 'Anonymous clients have no access to habit_occurrences'; end if; end $test$;

-- 118. habit_executions has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.habit_executions'::regclass)) then raise exception 'habit_executions has row-level security enabled'; end if; end $test$;

-- 119. Anonymous clients have no access to habit_executions
do $test$ begin if not (not has_table_privilege('anon','public.habit_executions','SELECT') and not has_table_privilege('anon','public.habit_executions','INSERT') and not has_table_privilege('anon','public.habit_executions','UPDATE') and not has_table_privilege('anon','public.habit_executions','DELETE')) then raise exception 'Anonymous clients have no access to habit_executions'; end if; end $test$;

-- 120. time_blocks has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.time_blocks'::regclass)) then raise exception 'time_blocks has row-level security enabled'; end if; end $test$;

-- 121. Anonymous clients have no access to time_blocks
do $test$ begin if not (not has_table_privilege('anon','public.time_blocks','SELECT') and not has_table_privilege('anon','public.time_blocks','INSERT') and not has_table_privilege('anon','public.time_blocks','UPDATE') and not has_table_privilege('anon','public.time_blocks','DELETE')) then raise exception 'Anonymous clients have no access to time_blocks'; end if; end $test$;

-- 122. time_block_tasks has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.time_block_tasks'::regclass)) then raise exception 'time_block_tasks has row-level security enabled'; end if; end $test$;

-- 123. Anonymous clients have no access to time_block_tasks
do $test$ begin if not (not has_table_privilege('anon','public.time_block_tasks','SELECT') and not has_table_privilege('anon','public.time_block_tasks','INSERT') and not has_table_privilege('anon','public.time_block_tasks','UPDATE') and not has_table_privilege('anon','public.time_block_tasks','DELETE')) then raise exception 'Anonymous clients have no access to time_block_tasks'; end if; end $test$;

-- 124. time_block_habit_occurrences has row-level security enabled
do $test$ begin if not ((select relrowsecurity from pg_class where oid='public.time_block_habit_occurrences'::regclass)) then raise exception 'time_block_habit_occurrences has row-level security enabled'; end if; end $test$;

-- 125. Anonymous clients have no access to time_block_habit_occurrences
do $test$ begin if not (not has_table_privilege('anon','public.time_block_habit_occurrences','SELECT') and not has_table_privilege('anon','public.time_block_habit_occurrences','INSERT') and not has_table_privilege('anon','public.time_block_habit_occurrences','UPDATE') and not has_table_privilege('anon','public.time_block_habit_occurrences','DELETE')) then raise exception 'Anonymous clients have no access to time_block_habit_occurrences'; end if; end $test$;

-- 126. No goal table is created
do $test$ begin if not (to_regclass('public.goals') is null) then raise exception 'No goal table is created'; end if; end $test$;

-- 127. No privileged SECURITY DEFINER functions are introduced
do $test$ begin if not (not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='planner_private' and p.prosecdef)) then raise exception 'No privileged SECURITY DEFINER functions are introduced'; end if; end $test$;
rollback;
select 127 as passed_checks, 'All checks passed; test transaction rolled back' as result;
