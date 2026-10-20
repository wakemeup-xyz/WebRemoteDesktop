from deployment import *
from known_attempt_quiescence import *
def main():
 os.umask(0o077);p=args_parser(__doc__,assets=False);p.add_argument('--phase',choices=('apply','reload'),required=True);p.add_argument('--apply-sha256');a=p.parse_args();f,m,b,changes=frozen(a.frozen_dir,a.frozen_sha256,applied=a.phase=='reload')
 if a.phase=='reload':applied_record(f,m,a.frozen_sha256,a.apply_sha256)
 else:need(a.apply_sha256 is None,'apply phase no prior apply')
 need(not (f/(a.phase+'-started.json')).exists(),'operation already consumed');known=all_known();ob=live_observe(known);v=receipt_value(m,a.frozen_sha256,a.phase,a.apply_sha256,ob);fresh_at(v,clock_pair(time.time,time.monotonic));out=f/('quiescence-'+a.phase+'.json');dg=jsonwrite(out,v);print(json.dumps({'record':str(out),'sha256':dg,'scope':SCOPE,'fullProcessTreeExit':'unknown'}));return 0
if __name__=='__main__':raise SystemExit(main())
