import { Compass } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Compass className="h-5 w-5" /> Page not found</CardTitle>
          <CardDescription>The page you requested isn't part of this build.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="secondary"><a href="/">Back to dashboard</a></Button>
        </CardContent>
      </Card>
    </div>
  );
}
