function deleteTimesheet({sql}) {
  return async(req,res)=>{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Invalid timesheet entry.'});
    try{
      const removed=await sql`DELETE FROM timesheets WHERE id=${id}::int AND COALESCE(locked,false)=false RETURNING id`;
      if(removed.length)return res.json({ok:true,id:removed[0].id});
      const existing=await sql`SELECT id FROM timesheets WHERE id=${id}::int`;
      if(!existing.length)return res.status(404).json({error:'This timesheet entry no longer exists. Reload the list.'});
      return res.status(409).json({error:'This entry is locked. Unlock the employee’s cutoff before deleting it.'});
    }catch{return res.status(500).json({error:'Unable to delete the timesheet entry. Reload the list to check its status before retrying.'});}
  };
}
module.exports={deleteTimesheet};
