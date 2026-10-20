from contextlib import contextmanager
VALIDATION=('rows','worker','coverage','signals','diagnostics','source-pins','manifest','runtime-integrity','sticky-observation','terminal-evidence')

class ValidationStages:
 def __init__(self):self.states={name:'not-evaluated' for name in VALIDATION};self.first_failure=None;self.next=0
 @contextmanager
 def stage(self,name):
  if self.first_failure is not None or self.next>=len(VALIDATION) or name!=VALIDATION[self.next]:raise ValueError('validation stage order')
  self.next+=1;self.states[name]='evaluated'
  try:yield
  except BaseException:
   self.states[name]='failed';self.first_failure=name;raise
  else:self.states[name]='passed'
 def snapshot(self):return {'stages':dict(self.states),'firstFailedStage':self.first_failure}
